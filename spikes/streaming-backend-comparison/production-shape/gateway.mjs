import { DeliverPolicy } from "@nats-io/jetstream";
import { createServer } from "node:http";
import {
  BROWSER_TOKEN,
  STREAM_NAME,
  SUBJECT_PREFIX,
  connectJetStream,
  createPool,
  decode,
  sessionSubject,
} from "./common.mjs";

const pool = createPool(32);
const runtime = await connectJetStream("pi-cloud-production-shape-sse");
const connectionsBySession = new Map();
let activeConnections = 0;
let deliveredEvents = 0;

function remove(state) {
  if (state.closed) return;
  state.closed = true;
  activeConnections -= 1;
  const current = connectionsBySession.get(state.sessionId);
  current?.delete(state);
  if (current?.size === 0) connectionsBySession.delete(state.sessionId);
}

function sendEvent(state, value, streamSequence) {
  if (state.closed || streamSequence <= state.lastSequence) return;
  const frame = `id: ${String(streamSequence)}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  if (!state.response.write(frame)) {
    // One slow browser must not block every Session on the shared Core NATS
    // subscription. Closing forces the browser to resume from its last ID.
    state.response.destroy();
    remove(state);
    return;
  }
  state.lastSequence = streamSequence;
  deliveredEvents += 1;
}

function flushPending(state) {
  state.replaying = false;
  for (const [streamSequence, value] of [...state.pending].sort(
    ([left], [right]) => left - right,
  )) {
    sendEvent(state, value, streamSequence);
  }
  state.pending.clear();
}

const liveSubscription = runtime.connection.subscribe("pc.live.>");
const liveLoop = (async () => {
  for await (const message of liveSubscription) {
    const originalSubject = message.headers?.get("Nats-Subject") ?? "";
    const streamSequence = Number(message.headers?.get("Nats-Sequence") ?? "0");
    const prefix = `${SUBJECT_PREFIX}.`;
    if (!originalSubject.startsWith(prefix) || !Number.isSafeInteger(streamSequence)) continue;
    const sessionId = originalSubject.slice(prefix.length);
    const value = decode(message.data);
    if (value.sessionId !== sessionId) continue;
    for (const state of connectionsBySession.get(sessionId) ?? []) {
      if (state.replaying) state.pending.set(streamSequence, value);
      else sendEvent(state, value, streamSequence);
    }
  }
})();

// Core NATS live delivery is transient. A broker disconnect therefore closes
// public streams so browsers resume from their last durable JetStream cursor.
const statusLoop = (async () => {
  for await (const status of runtime.connection.status()) {
    if (status.type !== "disconnect") continue;
    for (const states of connectionsBySession.values()) {
      for (const state of states) state.response.destroy();
    }
  }
})();

async function replayToBoundary(state, subject, afterSequence) {
  const latest = await runtime.manager.streams.getMessage(STREAM_NAME, {
    last_by_subj: subject,
  });
  if (latest === null || latest.seq <= afterSequence || state.closed) {
    flushPending(state);
    return;
  }
  const targetSequence = latest.seq;
  const consumer = await runtime.jetstream.consumers.get(STREAM_NAME, {
    name_prefix: `r${Math.random().toString(36).slice(2, 10)}`,
    filter_subjects: subject,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: afterSequence + 1,
    inactive_threshold: 10_000,
  });
  try {
    while (!state.closed && state.lastSequence < targetSequence) {
      const message = await consumer.next({ expires: 2_000 });
      if (message === null) throw new Error("replay_boundary_unavailable");
      const value = decode(message.data);
      if (value.sessionId !== state.sessionId) throw new Error("replay_session_mismatch");
      sendEvent(state, value, message.info.streamSequence);
    }
  } finally {
    await consumer.delete().catch(() => undefined);
  }
  if (!state.closed) flushPending(state);
}

async function openStream(request, response, sessionId, afterSequence) {
  const session = await pool.query(
    "select 1 from spike_sessions where tenant_id = 'tenant-a' and session_id = $1",
    [sessionId],
  );
  if (session.rowCount !== 1) {
    response.writeHead(404).end();
    return;
  }
  const state = {
    sessionId,
    response,
    lastSequence: afterSequence,
    replaying: true,
    pending: new Map(),
    closed: false,
  };
  const current = connectionsBySession.get(sessionId) ?? new Set();
  current.add(state);
  connectionsBySession.set(sessionId, current);
  activeConnections += 1;
  request.once("aborted", () => remove(state));
  response.once("close", () => remove(state));
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.write(": ready\n\n");
  try {
    await replayToBoundary(state, sessionSubject(sessionId), afterSequence);
  } catch {
    response.destroy();
    remove(state);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ready",
          activeConnections,
          deliveredEvents,
          routedSessions: connectionsBySession.size,
          rssBytes: process.memoryUsage().rss,
        }),
      );
      return;
    }
    if (request.headers.authorization !== `Bearer ${BROWSER_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/sessions\/([a-zA-Z0-9_-]{1,128})\/events$/.exec(url.pathname);
    const afterSequence = Number(url.searchParams.get("after") ?? "0");
    if (match === null || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      response.writeHead(400).end();
      return;
    }
    await openStream(request, response, match[1], afterSequence);
  } catch {
    if (!response.headersSent) response.writeHead(503).end();
    else response.destroy();
  }
});

server.listen(18091, "127.0.0.1", () => process.send?.({ type: "ready" }));

async function close() {
  for (const states of connectionsBySession.values()) {
    for (const state of states) state.response.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
  liveSubscription.unsubscribe();
  await runtime.connection.close();
  await Promise.allSettled([liveLoop, statusLoop]);
  await pool.end();
}

process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
