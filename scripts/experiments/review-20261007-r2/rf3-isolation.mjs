// Positive isolation/replay evidence with an owned three-broker fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { testKafka } from "../../lib/test-kafka.mjs";
import native from "@confluentinc/kafka-javascript";
import { KafkaLogConsumer } from "../../../packages/event-log/src/kafka-log-consumer.ts";
const f = await testKafka({}),
  topic = "pi-cloud.review-r2." + randomUUID(),
  groupId = "review-r2-" + randomUUID();
const kafka = new native.KafkaJS.Kafka({
    kafkaJS: {
      brokers: f.brokers,
      clientId: randomUUID(),
      logLevel: native.KafkaJS.logLevel.NOTHING,
    },
  }),
  admin = kafka.admin();
let first, second;
const release = Promise.withResolvers(),
  entered = Promise.withResolvers();
let handoffs = 0;
const seen = new Map();
const started = performance.now();
async function until(check, label) {
  const end = Date.now() + 45000;
  while (!check()) {
    if (Date.now() > end) throw Error(label + " timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function consumer(replay) {
  return new KafkaLogConsumer({
    brokers: f.brokers,
    topic,
    groupId,
    clientId: randomUUID(),
    groupRecovery: true,
    orderedEffects: true,
    ...(replay
      ? { replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.low])) }
      : {}),
    decode: (b) => JSON.parse(b.toString()),
    handler: async (record, current, commit) => {
      if (record.fact.kind === "tool" && (await commit())) {
        handoffs++;
        entered.resolve();
        await release.promise;
      }
      if (current()) seen.set(record.fact.id, performance.now() - started);
    },
  });
}
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
  first = consumer(false);
  await first.start();
  await first.waitUntilAssigned();
  const writers = await Promise.all(
    [0, 1].map((p) => first.openPublicationWriter(p, () => first.ownsPartition(p))),
  );
  const append = (p, body) =>
    writers[p].append({
      factId: randomUUID(),
      sessionId: body.session,
      value: JSON.stringify(body),
    });
  await append(0, { id: "slow", session: "A", kind: "tool" });
  await entered.promise;
  const at = performance.now();
  await Promise.all([
    append(0, { id: "same-partition", session: "B", kind: "text" }),
    append(1, { id: "other-partition", session: "C", kind: "text" }),
  ]);
  await until(() => seen.has("other-partition"), "other partition");
  const otherFinishedWhileBlocked = !seen.has("same-partition"),
    otherMs = performance.now() - at;
  assert(otherFinishedWhileBlocked);
  await new Promise((r) => setTimeout(r, 250));
  release.resolve();
  await until(() => seen.has("same-partition"), "same partition after release");
  const delayedMs = performance.now() - at;
  await first.close();
  first = undefined;
  second = consumer(true);
  await second.start();
  await second.waitUntilInitialReplay(await second.captureEndOffsets());
  assert.equal(handoffs, 1);
  const result = {
    scope:
      "Isolated RF3 and actual partition reader/publisher; controlled external handoff, no PG/model/production fault",
    otherFinishedWhileBlocked,
    otherPartitionMs: otherMs,
    samePartitionMs: delayedMs,
    toolHandoffsAfterConsumerReplacementAndRewind: handoffs,
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  release.resolve();
  await second?.close();
  await first?.close();
  await admin.disconnect();
  await f.close();
}
