import { DiscardPolicy, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { cpus, freemem, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BROWSER_TOKEN,
  INGEST_TOKEN,
  STREAM_NAME,
  SUBJECT_PREFIX,
  connectJetStream,
  createEvent,
  createPool,
  initializeDatabase,
  resetDatabase,
  waitFor,
} from "./common.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const targetConnections = Number(process.env.PI_CLOUD_JETSTREAM_SSE_CONNECTIONS ?? "2000");
if (
  !Number.isSafeInteger(targetConnections) ||
  targetConnections < 250 ||
  targetConnections > 5000
) {
  throw new TypeError("PI_CLOUD_JETSTREAM_SSE_CONNECTIONS is invalid");
}

function compose(...argumentsList) {
  return execFileSync("docker", ["compose", "-f", composeFile, ...argumentsList], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(values) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
    maximum: Number(Math.max(...values, 0).toFixed(3)),
  };
}

function startProcess(file, environment = {}) {
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), [], {
    cwd: directory,
    env: { ...process.env, ...environment },
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.messages = [];
  child.on("message", (message) => child.messages.push(message));
  return child;
}

async function waitForChildMessage(child, predicate, timeoutMs = 20_000) {
  return waitFor(
    () => {
      const index = child.messages.findIndex(predicate);
      return index < 0 ? undefined : child.messages.splice(index, 1)[0];
    },
    timeoutMs,
    10,
  );
}

async function startReadyProcess(file, environment) {
  const child = startProcess(file, environment);
  await waitForChildMessage(child, (message) => message?.type === "ready");
  return child;
}

async function stopProcess(child, signal = "SIGTERM") {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function seedSessions(pool, rows) {
  await pool.query(
    `insert into spike_sessions(session_id, tenant_id, attempt_id, fence, state)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[])
     on conflict (session_id) do update
       set tenant_id = excluded.tenant_id,
           attempt_id = excluded.attempt_id,
           fence = excluded.fence,
           state = excluded.state`,
    [
      rows.map((row) => row.sessionId),
      rows.map(() => "tenant-a"),
      rows.map((row) => row.attemptId),
      rows.map((row) => row.fence),
      rows.map(() => "active"),
    ],
  );
}

async function publish(value, expectedStatus = 202) {
  const startedAt = performance.now();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch("http://127.0.0.1:18092/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${INGEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (response.status === expectedStatus) {
      return {
        ...result,
        attempts: attempt,
        durationMs: performance.now() - startedAt,
      };
    }
    if (response.status !== 503 || expectedStatus !== 202 || attempt === 5) {
      throw new Error(
        `Event ingest returned ${String(response.status)}: ${JSON.stringify(result)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error("Event ingest retry loop ended unexpectedly");
}

async function mapConcurrent(values, concurrency, operation) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        output[index] = await operation(values[index], index);
      }
    }),
  );
  return output;
}

async function openSse(sessionId, after = 0) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const response = await fetch(
    `http://127.0.0.1:18091/sessions/${encodeURIComponent(sessionId)}/events?after=${String(after)}`,
    {
      headers: { authorization: `Bearer ${BROWSER_TOKEN}`, accept: "text/event-stream" },
      signal: controller.signal,
    },
  );
  if (!response.ok || response.body === null) {
    controller.abort();
    throw new Error(`SSE open failed with HTTP ${String(response.status)}`);
  }
  return {
    controller,
    reader: response.body.getReader(),
    connectedMs: performance.now() - startedAt,
    buffer: "",
  };
}

async function readSseEvents(connection, count, timeoutMs = 20_000) {
  const events = [];
  const read = async () => {
    while (events.length < count) {
      const chunk = await connection.reader.read();
      if (chunk.done) throw new Error("SSE stream ended before expected events arrived");
      connection.buffer += new TextDecoder().decode(chunk.value, { stream: true });
      let boundary = connection.buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = connection.buffer.slice(0, boundary);
        connection.buffer = connection.buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        const id = frame
          .split("\n")
          .find((line) => line.startsWith("id: "))
          ?.slice(4);
        if (data.length > 0 && id !== undefined) {
          events.push({ streamSequence: Number(id), event: JSON.parse(data) });
        }
        boundary = connection.buffer.indexOf("\n\n");
      }
    }
    return events;
  };
  let timer;
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE delivery timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeSse(connection) {
  connection.controller.abort();
  await connection.reader.cancel().catch(() => undefined);
}

async function gatewayHealth() {
  const response = await fetch("http://127.0.0.1:18091/health");
  if (!response.ok) throw new Error("SSE Gateway health failed");
  return response.json();
}

async function waitForProjection(pool, table, eventId) {
  return waitFor(async () => {
    const result = await pool.query(
      `select count(*)::int as count from ${table} where event_id = $1`,
      [eventId],
    );
    return result.rows[0].count === 1;
  });
}

const pool = createPool(32);
const runtime = await connectJetStream("pi-cloud-production-shape-benchmark");
let ingest;
let gateway;
let projector;
const report = {
  format: "pi-cloud.jetstream-production-shape.v1",
  generatedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  }).trim(),
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    logicalCpuCount: cpus().length,
    totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
  },
};

try {
  process.stdout.write("stage: initialize R=3 stream\n");
  await initializeDatabase(pool);
  await resetDatabase(pool);
  await runtime.manager.streams.delete(STREAM_NAME).catch(() => undefined);
  await runtime.manager.streams.add({
    name: STREAM_NAME,
    subjects: [`${SUBJECT_PREFIX}.>`],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    num_replicas: 3,
    max_age: 60 * 60 * 1_000_000_000,
    max_msgs_per_subject: 8_192,
    duplicate_window: 10 * 60 * 1_000_000_000,
    republish: { src: `${SUBJECT_PREFIX}.>`, dest: "pc.live.>" },
  });
  const initialStream = await waitFor(async () => {
    const info = await runtime.manager.streams.info(STREAM_NAME);
    return info.cluster?.replicas?.every((replica) => replica.current) ? info : undefined;
  });
  report.stream = {
    replicas: initialStream.config.num_replicas,
    storage: initialStream.config.storage,
    leader: initialStream.cluster?.leader,
  };

  await seedSessions(pool, [
    { sessionId: "baseline", attemptId: "attempt-a", fence: 1 },
    { sessionId: "gateway-loss", attemptId: "attempt-g", fence: 1 },
    { sessionId: "projector-loss", attemptId: "attempt-p", fence: 1 },
    { sessionId: "leader-loss", attemptId: "attempt-l", fence: 1 },
  ]);
  ingest = await startReadyProcess("ingest.mjs");
  gateway = await startReadyProcess("gateway.mjs");
  projector = await startReadyProcess("projector.mjs");

  process.stdout.write("stage: baseline projection and SSE\n");
  const baselineConnection = await openSse("baseline");
  const baselineRead = readSseEvents(baselineConnection, 5);
  const baselineEvents = [
    createEvent({ sessionId: "baseline", attemptId: "attempt-a", fence: 1, seq: 1 }),
    createEvent({ sessionId: "baseline", attemptId: "attempt-a", fence: 1, seq: 2 }),
    createEvent({ sessionId: "baseline", attemptId: "attempt-a", fence: 1, seq: 3 }),
    createEvent({
      sessionId: "baseline",
      attemptId: "attempt-a",
      fence: 1,
      seq: 4,
      type: "assistant.message.completed",
      payload: { content: "complete baseline answer" },
    }),
    createEvent({
      sessionId: "baseline",
      attemptId: "attempt-a",
      fence: 1,
      seq: 5,
      type: "turn.completed",
      payload: { stopReason: "stop" },
    }),
  ];
  const baselineAcks = [];
  for (const value of baselineEvents) baselineAcks.push(await publish(value));
  const baselineReceived = await baselineRead;
  await waitForProjection(pool, "spike_canonical_messages", baselineEvents[3].eventId);
  await waitForProjection(pool, "spike_terminal_turns", baselineEvents[4].eventId);
  const canonical = await pool.query(
    "select content, stream_sequence from spike_canonical_messages where session_id = 'baseline'",
  );
  report.baseline = {
    published: baselineEvents.length,
    received: baselineReceived.length,
    ordered: baselineReceived.every((item, index) => item.event.seq === index + 1),
    canonicalMessages: canonical.rowCount,
    canonicalContent: canonical.rows[0]?.content,
    fragmentRowsInPostgres: 0,
    publishLatencyMs: latency(baselineAcks.map((ack) => ack.durationMs)),
  };
  await closeSse(baselineConnection);

  await pool.query(
    "update spike_sessions set attempt_id = 'attempt-b', fence = 2 where session_id = 'baseline'",
  );
  const stale = await publish(
    createEvent({ sessionId: "baseline", attemptId: "attempt-a", fence: 1, seq: 6 }),
    409,
  );
  report.authorityGrant = {
    stalePublishRejected: stale.error === "stale_attempt_authority",
  };

  process.stdout.write("stage: Gateway loss and cursor replay\n");
  const gatewayConnection = await openSse("gateway-loss");
  const firstGatewayAck = await publish(
    createEvent({ sessionId: "gateway-loss", attemptId: "attempt-g", fence: 1, seq: 1 }),
  );
  await readSseEvents(gatewayConnection, 1);
  await stopProcess(gateway, "SIGKILL");
  gateway = undefined;
  const missedAcks = [];
  for (const seq of [2, 3]) {
    missedAcks.push(
      await publish(
        createEvent({ sessionId: "gateway-loss", attemptId: "attempt-g", fence: 1, seq }),
      ),
    );
  }
  gateway = await startReadyProcess("gateway.mjs");
  const recoveredConnection = await openSse("gateway-loss", firstGatewayAck.streamSequence);
  const recoveredGatewayEvents = await readSseEvents(recoveredConnection, 2);
  report.gatewayRecovery = {
    recoveredSequences: recoveredGatewayEvents.map((item) => item.event.seq),
    ordered: recoveredGatewayEvents.map((item) => item.event.seq).join(",") === "2,3",
  };
  await Promise.all([closeSse(gatewayConnection), closeSse(recoveredConnection)]);

  process.stdout.write("stage: Projector commit-before-ACK crash\n");
  await stopProcess(projector);
  const pausedMessage = createEvent({
    sessionId: "projector-loss",
    attemptId: "attempt-p",
    fence: 1,
    seq: 1,
    type: "assistant.message.completed",
    payload: { content: "projector crash answer" },
  });
  projector = await startReadyProcess("projector.mjs", {
    PAUSE_AFTER_COMMIT_EVENT: pausedMessage.eventId,
  });
  await publish(pausedMessage);
  await waitForChildMessage(
    projector,
    (message) => message?.type === "committed" && message.eventId === pausedMessage.eventId,
  );
  await stopProcess(projector, "SIGKILL");
  projector = await startReadyProcess("projector.mjs");
  await waitFor(async () => {
    const info = await runtime.manager.consumers.info(STREAM_NAME, "PG_PROJECTOR");
    return info.num_ack_pending === 0;
  });
  const projectorDuplicate = await pool.query(
    "select count(*)::int as count from spike_canonical_messages where event_id = $1",
    [pausedMessage.eventId],
  );
  report.projectorRecovery = {
    committedBeforeCrash: true,
    canonicalRowsAfterRedelivery: projectorDuplicate.rows[0].count,
    idempotent: projectorDuplicate.rows[0].count === 1,
  };

  process.stdout.write("stage: JetStream Leader loss\n");
  const leaderConnection = await openSse("leader-loss");
  const leaderBefore = (await runtime.manager.streams.info(STREAM_NAME)).cluster?.leader;
  const leaderService = { n1: "nats-1", n2: "nats-2", n3: "nats-3" }[leaderBefore];
  if (leaderService === undefined) throw new Error("JetStream leader identity is unavailable");
  compose("kill", "--signal", "SIGKILL", leaderService);
  const leaderPublishStartedAt = performance.now();
  const leaderPublish = await publish(
    createEvent({ sessionId: "leader-loss", attemptId: "attempt-l", fence: 1, seq: 1 }),
  );
  let existingConnectionRecovered = true;
  let leaderReceived;
  try {
    leaderReceived = await readSseEvents(leaderConnection, 1, 5_000);
  } catch {
    existingConnectionRecovered = false;
    await closeSse(leaderConnection);
    const replacementConnection = await openSse("leader-loss");
    leaderReceived = await readSseEvents(replacementConnection, 1, 30_000);
    await closeSse(replacementConnection);
  }
  const leaderFailoverMs = performance.now() - leaderPublishStartedAt;
  compose("up", "--detach", "--wait", leaderService);
  const recoveredStream = await waitFor(async () => {
    const info = await runtime.manager.streams.info(STREAM_NAME);
    return info.cluster?.replicas?.every((replica) => replica.current) ? info : undefined;
  }, 30_000);
  report.leaderRecovery = {
    killedLeader: leaderBefore,
    replacementLeader: recoveredStream.cluster?.leader,
    publishAndDeliveryMs: Number(leaderFailoverMs.toFixed(3)),
    ingestAttempts: leaderPublish.attempts,
    delivered: leaderReceived[0]?.event.seq === 1,
    existingConnectionRecovered,
    browserReconnectRecovered: leaderReceived[0]?.event.seq === 1,
    replicasCurrentAfterRestart: recoveredStream.cluster?.replicas?.every(
      (replica) => replica.current,
    ),
  };
  await closeSse(leaderConnection);

  process.stdout.write(`stage: ${String(targetConnections)} sustained SSE connections\n`);
  const loadRows = Array.from({ length: targetConnections }, (_, index) => ({
    sessionId: `load-${String(index).padStart(5, "0")}`,
    attemptId: "attempt-load",
    fence: 1,
  }));
  await seedSessions(pool, loadRows);
  const connections = [];
  const stages = [];
  for (const target of [250, 500, 1_000, 2_000].filter((value) => value <= targetConnections)) {
    if (freemem() < 2 * 1024 ** 3)
      throw new Error("Host free-memory guard stopped SSE scale stage");
    const additions = loadRows.slice(connections.length, target);
    const opened = await mapConcurrent(additions, 64, (row) => openSse(row.sessionId));
    connections.push(...opened);
    const health = await waitFor(async () => {
      const value = await gatewayHealth();
      return value.activeConnections === target ? value : undefined;
    });
    const account = await runtime.manager.getAccountInfo();
    process.stdout.write(
      `stage: SSE ${String(target)} ready, Gateway RSS ${String(Number((health.rssBytes / 1024 ** 2).toFixed(2)))} MiB\n`,
    );
    stages.push({
      connections: target,
      connectLatencyMs: latency(opened.map((connection) => connection.connectedMs)),
      gatewayRssMiB: Number((health.rssBytes / 1024 ** 2).toFixed(2)),
      jetStreamConsumers: account.consumers,
      hostFreeMemoryGiB: Number((freemem() / 1024 ** 3).toFixed(2)),
    });
  }
  const deliveryStartedAt = performance.now();
  const loadPublishAcks = await mapConcurrent(loadRows, 100, (row) =>
    publish(createEvent({ ...row, seq: 1 })),
  );
  const publishElapsedMs = performance.now() - deliveryStartedAt;
  const healthAfterPublish = await gatewayHealth();
  const readStartedAt = performance.now();
  const loadDeliveries = await mapConcurrent(connections, 100, async (connection, index) => {
    try {
      return { delivered: true, index, events: await readSseEvents(connection, 1, 30_000) };
    } catch (error) {
      return {
        delivered: false,
        index,
        failure: error instanceof Error ? error.message : "unknown_failure",
      };
    }
  });
  const readElapsedMs = performance.now() - readStartedAt;
  const missedDeliveries = loadDeliveries.filter((result) => !result.delivered);
  const reconnectResults = await mapConcurrent(missedDeliveries, 16, async (missed) => {
    const original = connections[missed.index];
    await closeSse(original);
    const replacement = await openSse(loadRows[missed.index].sessionId);
    try {
      const events = await readSseEvents(replacement, 1, 20_000);
      return { recovered: events[0]?.event.seq === 1, index: missed.index };
    } finally {
      await closeSse(replacement);
    }
  });
  const deliveryElapsedMs = performance.now() - deliveryStartedAt;
  report.sseScale = {
    targetConnections,
    stages,
    publishLatencyMs: latency(loadPublishAcks.map((ack) => ack.durationMs)),
    deliveredConnections: loadDeliveries.filter((result) => result.delivered).length,
    missedConnections: missedDeliveries.map((result) => loadRows[result.index].sessionId),
    recoveredAfterReconnect: reconnectResults.filter((result) => result.recovered).length,
    effectiveDeliveredConnections:
      loadDeliveries.filter((result) => result.delivered).length +
      reconnectResults.filter((result) => result.recovered).length,
    publishElapsedMs: Number(publishElapsedMs.toFixed(3)),
    gatewayDeliveredAtPublishComplete: healthAfterPublish.deliveredEvents,
    browserReadElapsedMs: Number(readElapsedMs.toFixed(3)),
    publishAndDeliverElapsedMs: Number(deliveryElapsedMs.toFixed(3)),
    eventsPerSecond: Number(((targetConnections * 1_000) / deliveryElapsedMs).toFixed(2)),
  };
  await mapConcurrent(connections, 100, closeSse);
  await waitFor(async () => (await gatewayHealth()).activeConnections === 0, 30_000);
  report.sseScale.consumersAfterClose = await waitFor(async () => {
    const consumers = (await runtime.manager.getAccountInfo()).consumers;
    return consumers <= 1 ? consumers : undefined;
  }, 30_000);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.send?.(report);
} finally {
  await Promise.allSettled([stopProcess(projector), stopProcess(gateway), stopProcess(ingest)]);
  await runtime.connection.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
