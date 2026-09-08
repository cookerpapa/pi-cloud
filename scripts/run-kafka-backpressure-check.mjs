import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

if (process.env.PI_CLOUD_LIVE_BACKPRESSURE_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_BACKPRESSURE_CHECK=1 for isolated Kafka capacity acceptance");
if (process.argv[2] !== "inside") {
  const exec = promisify(execFile),
    runner = `pi-cloud-backpressure-${randomUUID()}`;
  try {
    const { stdout } = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        runner,
        "--network",
        "pi-cloud-production_event-log",
        "--cpus",
        "2",
        "--memory",
        "1g",
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "-e",
        "PI_CLOUD_LIVE_BACKPRESSURE_CHECK",
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
        "node",
        "--import",
        "tsx",
        "scripts/run-kafka-backpressure-check.mjs",
        "inside",
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"format"')),
    );
    report.revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
    report.workingTreeDirty = true;
    await writeFile(
      "docs/reports/transport-backpressure-acceptance-latest.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    await exec("docker", ["rm", "-f", runner]).catch(() => {});
  }
} else {
  const { Admin } = await import("@platformatic/kafka");
  const { KafkaAcceptedFactBus } =
    await import("../packages/runtime-core/src/kafka-accepted-fact.ts");
  const { KafkaLogConsumer } = await import("@pi-cloud/event-log");
  const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    id = randomUUID();
  const topic = `pi-cloud.backpressure-check.${id}`,
    clientId = `backpressure-${id}`;
  const producerId = `${clientId}-accepted-fact-producer-1`;
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: `capacity-admin-${id}` });
  const capacity = { maximumPendingBytes: 4 * 1024 * 1024, maximumPendingFacts: 4096 };
  const bus = new KafkaAcceptedFactBus({
    brokers,
    clientId,
    topic,
    partitions: 1,
    replicas: 3,
    retentionMs: 3600000,
    producerLanes: 1,
    capacity,
  });
  const seen = new Set();
  const consumer = new KafkaLogConsumer({
    brokers,
    topic,
    clientId: `capacity-reader-${id}`,
    groupId: `capacity-reader-${id}`,
    commitMessages: false,
    decode: (bytes) => JSON.parse(bytes.toString()),
    replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.low])),
    handler: async ({ fact }) => {
      seen.add(fact.factId);
    },
  });
  const quota = async (remove) => {
    const results = await admin.alterClientQuotas({
      entries: [
        {
          entities: [{ entityType: "client-id", entityName: producerId }],
          ops: [
            remove
              ? { key: "producer_byte_rate", remove: true }
              : { key: "producer_byte_rate", value: 16384, remove: false },
          ],
        },
      ],
    });
    assert(
      results.every((r) => r.errorCode === 0),
      "Private producer quota update failed",
    );
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (predicate) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Capacity probe timed out");
      await delay(10);
    }
  };
  let quotaRemoval;
  try {
    await bus.start();
    await consumer.start();
    await quota(false);
    const accepted = new Set(),
      rejected = new Set(),
      started = performance.now();
    quotaRemoval = delay(2000).then(() => quota(true));
    const scope = {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      attemptId: randomUUID(),
      fencingToken: 1,
    };
    const results = await Promise.all(
      Array.from({ length: 6000 }, (_, i) => {
        const factId = randomUUID(),
          occurredAt = new Date().toISOString();
        return bus
          .append({
            kind: "agent_event",
            factId,
            scope,
            occurredAt,
            event: {
              schemaVersion: 1,
              eventId: factId,
              sessionId: scope.sessionId,
              turnId: scope.turnId,
              agentId: "root",
              seq: i + 1,
              type: "assistant.text.delta",
              payload: { text: "x".repeat(256) },
              occurredAt,
            },
          })
          .then(
            () => {
              accepted.add(factId);
              return true;
            },
            (error) => {
              assert.equal(error.code, "event_capacity_exhausted");
              rejected.add(factId);
              return false;
            },
          );
      }),
    );
    await quotaRemoval;
    await wait(() => seen.size === accepted.size);
    for (const factId of rejected) assert(!seen.has(factId), "Rejected Fact was published");
    const stats = bus.statistics();
    assert(stats.drainWaits > 0, "Real Writable backpressure was not exercised");
    assert(stats.capacityRejections > 0);
    assert(stats.peakPendingBytes <= capacity.maximumPendingBytes);
    assert.equal(stats.pendingBytes, 0);
    assert.equal(stats.pendingFacts, 0);
    assert.equal(results.filter(Boolean).length, accepted.size);
    console.log(
      JSON.stringify({
        format: "pi-cloud.transport-backpressure.v1",
        checkedAt: new Date().toISOString(),
        topology:
          "R=3 private one-partition topic; quota only on one unique test producer ID; 2 CPU/1 GiB runner",
        offered: results.length,
        accepted: accepted.size,
        rejected: rejected.size,
        persisted: seen.size,
        elapsedMs: Math.round(performance.now() - started),
        ...stats,
        interpretation:
          "overload/recovery proof, not unthrottled throughput or whole-process memory guarantee",
      }),
    );
  } finally {
    await quotaRemoval?.catch(() => undefined);
    await quota(true);
    const closed = await Promise.allSettled([consumer.close(), bus.close()]);
    await admin.deleteTopics({ topics: [topic] });
    await admin.close();
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
}
