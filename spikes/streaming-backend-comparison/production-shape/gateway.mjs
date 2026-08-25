import { DeliverPolicy } from "@nats-io/jetstream";
import { createServer } from "node:http";
import {
  BROWSER_TOKEN,
  STREAM_NAME,
  connectJetStream,
  createPool,
  decode,
  sessionSubject,
} from "./common.mjs";

const pool = createPool(32);
const runtime = await connectJetStream("pi-cloud-production-shape-sse");
let activeConnections = 0;
let deliveredEvents = 0;

async function openStream(request, response, sessionId, afterSequence) {
  const session = await pool.query(
    "select 1 from spike_sessions where tenant_id = 'tenant-a' and session_id = $1",
    [sessionId],
  );
  if (session.rowCount !== 1) {
    response.writeHead(404).end();
    return;
  }
  const consumer = await runtime.jetstream.consumers.get(STREAM_NAME, {
    name_prefix: `s${Math.random().toString(36).slice(2, 10)}`,
    filter_subjects: sessionSubject(sessionId),
    deliver_policy: afterSequence === 0 ? DeliverPolicy.All : DeliverPolicy.StartSequence,
    ...(afterSequence === 0 ? {} : { opt_start_seq: afterSequence + 1 }),
    inactive_threshold: 10_000,
  });
  const messages = await consumer.consume();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    activeConnections -= 1;
    await messages.close().catch(() => undefined);
    await consumer.delete().catch(() => undefined);
  };
  request.once("aborted", () => void close());
  response.once("close", () => void close());
  activeConnections += 1;
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  response.write(": ready\n\n");
  try {
    for await (const message of messages) {
      const value = decode(message.data);
      if (value.sessionId !== sessionId) throw new Error("filtered_consumer_session_mismatch");
      const streamSequence = message.info.streamSequence;
      if (streamSequence <= afterSequence) continue;
      const frame = `id: ${String(streamSequence)}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
      if (!response.write(frame)) await new Promise((resolve) => response.once("drain", resolve));
      deliveredEvents += 1;
    }
  } finally {
    await close();
    if (!response.writableEnded) response.end();
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
  await new Promise((resolve) => server.close(resolve));
  await runtime.connection.close();
  await pool.end();
}

process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
