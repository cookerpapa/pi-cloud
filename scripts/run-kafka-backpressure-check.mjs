import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { kafkaEvaluation } from "./lib/kafka-evaluation.mjs";

await kafkaEvaluation(
  "docs/reports/transport-backpressure-acceptance-latest.json",
  async (brokers) => {
    const { Admin } = await import("@platformatic/kafka");
    const { PublicationHarness } = await import("./lib/publication-harness.ts");
    const { KafkaLogConsumer } = await import("@pi-cloud/event-log");
    const id = randomUUID();
    const topic = `pi-cloud.backpressure-check.${id}`,
      clientId = `backpressure-${id}`;
    const producerId = `${clientId}-publication-0`;
    const admin = new Admin({ bootstrapBrokers: brokers, clientId: `capacity-admin-${id}` });
    const capacity = { maximumPendingBytes: 64 * 1024, maximumPendingFacts: 128 };
    const bus = new PublicationHarness({
      brokers,
      clientId,
      topic,
      partitions: 1,
      replicas: 3,
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
        piSessionId: randomUUID(),
        writerId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        fencingToken: 1,
      };
      let peakPendingBytes = 0;
      const sample = setInterval(() => {
        peakPendingBytes = Math.max(peakPendingBytes, bus.statistics().pendingBytes);
      }, 5);
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
                assert.equal(error.reason, "capacity");
                rejected.add(factId);
                return false;
              },
            );
        }),
      );
      clearInterval(sample);
      await quotaRemoval;
      await wait(() => seen.size === accepted.size);
      for (const factId of rejected) assert(!seen.has(factId), "Rejected Fact was published");
      const stats = bus.statistics();
      assert(rejected.size > 0);
      assert(peakPendingBytes <= capacity.maximumPendingBytes);
      assert.equal(stats.pendingBytes, 0);
      assert.equal(stats.pendingFacts, 0);
      assert.equal(results.filter(Boolean).length, accepted.size);
      return {
        format: "pi-cloud.transport-backpressure.v2",
        checkedAt: new Date().toISOString(),
        topology: "R=3 private one-partition topic; quota only on one unique test producer ID",
        offered: results.length,
        accepted: accepted.size,
        rejected: rejected.size,
        persisted: seen.size,
        elapsedMs: Math.round(performance.now() - started),
        ...stats,
        interpretation:
          "overload/recovery proof, not unthrottled throughput or whole-process memory guarantee",
      };
    } finally {
      await quotaRemoval?.catch(() => undefined);
      await quota(true);
      const closed = await Promise.allSettled([consumer.close(), bus.close()]);
      await admin.deleteTopics({ topics: [topic] });
      await admin.close();
      for (const result of closed) if (result.status === "rejected") throw result.reason;
    }
  },
);
