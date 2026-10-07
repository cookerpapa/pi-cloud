// Bounded 32-partition sample on isolated RF3 Kafka, not a fleet SLO.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import native from "@confluentinc/kafka-javascript";
import { testKafka } from "../../lib/test-kafka.mjs";
import { KafkaLogConsumer } from "../../../packages/event-log/src/kafka-log-consumer.ts";
const fixture = await testKafka({}),
  topic = `pi-cloud.commit-load.${randomUUID()}`;
const kafka = new native.KafkaJS.Kafka({
    kafkaJS: {
      brokers: fixture.brokers,
      clientId: randomUUID(),
      logLevel: native.KafkaJS.logLevel.NOTHING,
    },
  }),
  admin = kafka.admin();
let consumer,
  commits = 0;
const partitions = new Set(),
  latencies = [],
  sent = new Map(),
  seen = new Set();
const original = native.KafkaConsumer.prototype.commit;
native.KafkaConsumer.prototype.commit = function (offsets) {
  for (const offset of offsets ?? []) if (offset.topic === topic) partitions.add(offset.partition);
  if (offsets?.some((o) => o.topic === topic)) commits++;
  return original.apply(this, arguments);
};
const until = async (condition) => {
  const end = Date.now() + 60000;
  while (!condition()) {
    if (Date.now() > end) throw Error("Load progress timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
try {
  await admin.connect();
  await admin.createTopics({
    topics: [
      {
        topic,
        numPartitions: 32,
        replicationFactor: 3,
        configEntries: [{ name: "min.insync.replicas", value: "2" }],
      },
    ],
  });
  consumer = new KafkaLogConsumer({
    brokers: fixture.brokers,
    topic,
    groupId: randomUUID(),
    clientId: randomUUID(),
    groupRecovery: true,
    orderedEffects: true,
    decode: (bytes) => JSON.parse(bytes.toString()),
    handler: async ({ fact }) => {
      if (!seen.has(fact.id)) {
        seen.add(fact.id);
        latencies.push(performance.now() - sent.get(fact.id));
      }
    },
  });
  await consumer.start();
  await consumer.waitUntilAssigned();
  const writers = await Promise.all(
    Array.from({ length: 32 }, (_, p) =>
      consumer.openPublicationWriter(p, () => consumer.ownsPartition(p)),
    ),
  );
  const started = performance.now();
  for (let round = 0; round < 4; round++) {
    await Promise.all(
      writers.map((writer, partition) => {
        const id = `${round}:${partition}`;
        sent.set(id, performance.now());
        return writer.append({
          factId: randomUUID(),
          sessionId: `fixture-${partition}`,
          value: JSON.stringify({ id }),
        });
      }),
    );
    await until(() => seen.size === (round + 1) * 32);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  await consumer.waitUntilInitialReplay(await consumer.captureEndOffsets());
  assert.equal(partitions.size, 32);
  assert.equal(seen.size, 128);
  assert(commits <= 256);
  const sorted = latencies.toSorted((a, b) => a - b);
  const report = {
    scope:
      "Isolated RF3, 32 actual transactional publishers and one native consumer; no PG/Tool/provider",
    partitions: 32,
    records: 128,
    ordinaryOffsetCommitCalls: commits,
    committedPartitions: partitions.size,
    sampleDurationMs: performance.now() - started,
    publicationToHandlerMs: {
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted.at(-1),
    },
    note: "Includes deliberate 1.1-second gaps; one bounded sample, no throughput/availability SLO",
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await consumer?.close();
  native.KafkaConsumer.prototype.commit = original;
  await admin.disconnect();
  await fixture.close();
}
