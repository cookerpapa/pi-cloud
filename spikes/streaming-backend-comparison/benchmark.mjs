import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { KafkaAdapter } from "./kafka-adapter.mjs";
import { NatsAdapter } from "./nats-adapter.mjs";
import { ValkeyAdapter } from "./valkey-adapter.mjs";
import {
  configuration,
  event,
  sessions as createSessions,
  summary,
  uniqueName,
  verifyOrder,
} from "./workload.mjs";

const spikeDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const workload = configuration();
const sessionIds = createSessions(workload.sessionCount);
const focusSessionId = sessionIds[Math.floor(sessionIds.length / 2)];
const runId = uniqueName("run").slice(0, 20).replaceAll("-", "");

function compose(...argumentsList) {
  return execFileSync("docker", ["compose", "-f", composeFile, ...argumentsList], {
    cwd: spikeDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function publishWorkload(adapter) {
  const acknowledgementLatenciesMs = [];
  const startedAt = performance.now();
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      for (let sequence = 1; sequence <= workload.eventsPerSession; sequence += 1) {
        const value = event(sessionId, sequence, workload.payloadBytes);
        const acknowledgementStartedAt = performance.now();
        await adapter.publish(value);
        acknowledgementLatenciesMs.push(performance.now() - acknowledgementStartedAt);
      }
    }),
  );
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    eventsPerSecond: (workload.logicalEvents * 1_000) / elapsedMs,
    acknowledgementLatenciesMs,
  };
}

function sequenceCount(result, sessionId) {
  return result.sequences.get(sessionId)?.length ?? 0;
}

async function processKillAndRestart(service) {
  const startedAt = performance.now();
  compose("kill", "--signal", "SIGKILL", service);
  compose("up", "--detach", "--wait", service);
  return performance.now() - startedAt;
}

async function runBackend(adapter, service) {
  await adapter.setup();
  const projector = await adapter.startProjector(workload.logicalEvents);
  const projectionStartedAt = performance.now();
  const published = await publishWorkload(adapter);
  await projector.completion;
  const projectionElapsedMs = performance.now() - projectionStartedAt;
  const projected = projector.result();
  const orderViolations = verifyOrder(projected.sequences, workload.eventsPerSession);
  await projector.close();

  const replayStartedAt = performance.now();
  const focused = await adapter.replaySession(focusSessionId, workload.eventsPerSession, "focused");
  const replayElapsedMs = performance.now() - replayStartedAt;
  const focusedOrderViolations = verifyOrder(focused.sequences, workload.eventsPerSession);

  const duplicateValue = event("dedup-session", 1, workload.payloadBytes);
  const firstDuplicateWrite = await adapter.publish(duplicateValue);
  const secondDuplicateWrite = await adapter.publish(duplicateValue);

  const sentinel = event(focusSessionId, workload.eventsPerSession + 1, workload.payloadBytes);
  await adapter.publish(sentinel);
  const restartElapsedMs = await processKillAndRestart(service);
  await adapter.reconnect?.();
  const recovered = await adapter.replaySession(
    focusSessionId,
    workload.eventsPerSession + 1,
    "recovery",
    true,
  );
  const recoveredSequences = recovered.sequences.get(focusSessionId) ?? [];

  const result = {
    backend: adapter.name,
    acknowledgementContract: adapter.acknowledgement,
    gatewayState: adapter.gatewayState,
    publish: {
      elapsedMs: Number(published.elapsedMs.toFixed(3)),
      eventsPerSecond: Number(published.eventsPerSecond.toFixed(2)),
      acknowledgementLatencyMs: summary(published.acknowledgementLatenciesMs),
    },
    globalProjection: {
      elapsedMs: Number(projectionElapsedMs.toFixed(3)),
      eventsPerSecond: Number(((workload.logicalEvents * 1_000) / projectionElapsedMs).toFixed(2)),
      deliveryLatencyMs: summary(projected.deliveryLatenciesMs),
      events: [...projected.sequences.values()].reduce((total, values) => total + values.length, 0),
      scannedRecords: projected.scannedRecords,
      orderViolations,
    },
    focusedReplay: {
      elapsedMs: Number(replayElapsedMs.toFixed(3)),
      deliveredEvents: sequenceCount(focused, focusSessionId),
      scannedRecords: focused.scannedRecords,
      scanAmplification: Number(
        (focused.scannedRecords / Math.max(1, sequenceCount(focused, focusSessionId))).toFixed(2),
      ),
      orderViolations: focusedOrderViolations,
    },
    duplicatePublication: {
      firstReportedDuplicate: firstDuplicateWrite.duplicate,
      secondReportedDuplicate: secondDuplicateWrite.duplicate,
    },
    processKillRecovery: {
      restartElapsedMs: Number(restartElapsedMs.toFixed(3)),
      recoveredEvents: recoveredSequences.length,
      acknowledgedSentinelRecovered: recoveredSequences.includes(workload.eventsPerSession + 1),
      scope: "broker process SIGKILL with persistent volume; not host power loss",
    },
  };
  await adapter.close();
  return result;
}

const adapters = [
  [new KafkaAdapter(runId), "kafka"],
  [new ValkeyAdapter(`${runId}ve`, sessionIds, "everysec"), "valkey"],
  [new ValkeyAdapter(`${runId}va`, sessionIds, "always"), "valkey"],
  [new NatsAdapter(runId), "nats"],
];
const results = [];
for (const [adapter, service] of adapters) {
  process.stdout.write(`benchmarking ${adapter.name}\n`);
  results.push(await runBackend(adapter, service));
}

const report = {
  format: "pi-cloud.streaming-backend-comparison.v1",
  generatedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
  topology: {
    scope: "isolated single-host single-node brokers",
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      logicalCpuCount: cpus().length,
      totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    },
    kafka: "pinned production Apache Kafka image; 16 partitions; replication factor 1",
    valkey: "Valkey 9.1.1; AOF everysec; no replica",
    nats: "NATS 2.14.5; JetStream file storage; one replica",
  },
  workload,
  focusSessionId,
  results,
  interpretationGuardrails: [
    "Absolute throughput is not comparable to a replicated multi-node production topology.",
    "Valkey AOF everysec can acknowledge before fsync; AOF always measures the stronger local-disk contract.",
    "Kafka focused replay scans interleaved partition records because Kafka has no per-key subscription.",
    "JetStream ordered consumers are ephemeral broker resources and their per-connection cost still needs a long-connection load test.",
    "Authority/fence validation and PostgreSQL semantic projection are intentionally outside this transport-only spike.",
  ],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.send?.(report);
