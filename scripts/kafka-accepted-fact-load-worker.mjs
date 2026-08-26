import { Admin } from "@platformatic/kafka";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { KafkaAcceptedFactBus } from "../packages/runtime-core/src/kafka-accepted-fact.ts";

const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"];
const topic = `pi-cloud.accepted-fact-benchmark-${Date.now().toString(36)}`;
const clientId = `pi-cloud-kafka-load-${randomUUID()}`;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(values) {
  return Object.fromEntries(
    [
      ["p50", 0.5],
      ["p95", 0.95],
      ["p99", 0.99],
    ].map(([name, fraction]) => [name, Number(percentile(values, fraction).toFixed(3))]),
  );
}

async function mapConcurrent(values, concurrency, operation) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        await operation(values[index], index);
      }
    }),
  );
}

function sessionSeed() {
  return {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    executionId: randomUUID(),
  };
}

function fact(seed, sequence, payloadBytes) {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  return {
    kind: "agent_event",
    factId: eventId,
    scope: {
      tenantId: seed.tenantId,
      sessionId: seed.sessionId,
      runId: seed.runId,
      turnId: seed.turnId,
      executionId: seed.executionId,
      executionGeneration: 1,
    },
    event: {
      schemaVersion: 1,
      eventId,
      sessionId: seed.sessionId,
      turnId: seed.turnId,
      agentId: "root",
      seq: sequence,
      occurredAt,
      type: "assistant.text.delta",
      payload: { text: "x".repeat(payloadBytes) },
    },
    occurredAt,
  };
}

const bus = new KafkaAcceptedFactBus({
  brokers,
  clientId,
  topic,
  partitions: 32,
  replicas: 3,
  retentionMs: 60 * 60_000,
});
const admin = new Admin({ clientId: `${clientId}-cleanup`, bootstrapBrokers: brokers });

try {
  await bus.start();
  const cases = [];
  for (const configuration of [
    { name: "concurrency-1", sessions: 1, eventsPerSession: 4_096, concurrency: 1 },
    { name: "concurrency-16", sessions: 16, eventsPerSession: 256, concurrency: 16 },
    { name: "concurrency-64", sessions: 64, eventsPerSession: 64, concurrency: 64 },
    { name: "concurrency-128", sessions: 128, eventsPerSession: 32, concurrency: 128 },
  ]) {
    const seeds = Array.from({ length: configuration.sessions }, sessionSeed);
    const latencies = [];
    const startedAt = performance.now();
    await mapConcurrent(seeds, configuration.concurrency, async (seed) => {
      for (let sequence = 1; sequence <= configuration.eventsPerSession; sequence += 1) {
        const eventStartedAt = performance.now();
        await bus.append(fact(seed, sequence, 256));
        latencies.push(performance.now() - eventStartedAt);
      }
    });
    const elapsedMs = performance.now() - startedAt;
    const events = configuration.sessions * configuration.eventsPerSession;
    cases.push({
      ...configuration,
      events,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      eventsPerSecond: Number(((events * 1_000) / elapsedMs).toFixed(2)),
      acknowledgementLatencyMs: latency(latencies),
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      format: "pi-cloud.kafka-accepted-fact-load.v1",
      generatedAt: new Date().toISOString(),
      host: {
        logicalCpuCount: cpus().length,
        totalMemoryGiB: Number((totalmem() / 1_024 ** 3).toFixed(2)),
        node: process.version,
      },
      kafka: { brokers: 3, partitions: 32, replicas: 3, acknowledgements: "all" },
      applicationMicrobatch: false,
      cases,
    })}\n`,
  );
} finally {
  await bus.close().catch(() => undefined);
  await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
  await admin.close().catch(() => undefined);
}
