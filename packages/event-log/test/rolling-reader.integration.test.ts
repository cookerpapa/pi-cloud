import { randomUUID } from "node:crypto";
import native from "@confluentinc/kafka-javascript";
import { expect, it, vi } from "vitest";
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!brokers)(
  "resumes a partition paused by an in-flight handler across an overlapping group handoff",
  async () => {
    const topic = `rolling-reader-${randomUUID()}`;
    const kafka = new native.KafkaJS.Kafka({
      kafkaJS: { brokers: brokers!, logLevel: native.KafkaJS.logLevel.NOTHING },
    });
    const admin = kafka.admin(),
      producer = kafka.producer({ kafkaJS: { acks: -1 } });
    const consumers: KafkaLogConsumer<{ id: string }>[] = [];
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const seen: string[] = [];
    const reader = (name: string) => {
      const c = new KafkaLogConsumer<{ id: string }>({
        brokers: brokers!,
        topic,
        groupId: topic,
        clientId: name,
        groupRecovery: true,
        orderedEffects: true,
        decode: (b) => JSON.parse(b.toString()),
        replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.low])),
        handler: async (record, current, commit) => {
          if (name.endsWith("-b") && record.fact.id === "hold") {
            held.resolve();
            await release.promise;
          }
          if (current?.() === false) return;
          if (await commit!()) seen.push(record.fact.id);
        },
      });
      consumers.push(c);
      return c;
    };
    const send = (partition: number, id: string) =>
      producer.send({
        topic,
        messages: [{ partition, key: "session", value: JSON.stringify({ id }) }],
      });
    try {
      await admin.connect();
      await admin.createTopics({
        topics: [
          {
            topic,
            numPartitions: 2,
            replicationFactor: 3,
            configEntries: [{ name: "min.insync.replicas", value: "2" }],
          },
        ],
      });
      await producer.connect();
      const a = reader(topic + "-a"),
        b = reader(topic + "-b");
      await a.start();
      await a.waitUntilAssigned(30000);
      await b.start();
      await vi.waitFor(() => expect(b.ownsPartition(1)).toBe(true), { timeout: 30000 });
      await send(1, "hold");
      await held.promise;
      await a.close();
      await vi.waitFor(() => expect(b.ownsPartition(1)).toBe(false), { timeout: 15000 });
      release.resolve();
      await vi.waitFor(() => expect(b.ownsPartition(0) && b.ownsPartition(1)).toBe(true), {
        timeout: 30000,
      });
      await send(1, "after-retained");
      await send(0, "after-gained");
      await vi.waitFor(() => expect(seen).toContain("after-retained"), { timeout: 10000 });
      await vi.waitFor(() => expect(seen).toContain("after-gained"), { timeout: 10000 });
    } finally {
      release.resolve();
      await Promise.allSettled(consumers.map((c) => c.close()));
      await producer.disconnect();
      await admin.deleteTopics({ topics: [topic] });
      await admin.disconnect();
    }
  },
  120000,
);
