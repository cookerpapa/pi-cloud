// Real isolated RF3 characterization. No production Kafka or model calls.
// node --import tsx scripts/experiments/kafka-worker-review-20261017/rebalance.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { testKafka } from "../../lib/test-kafka.mjs";
import {
  KafkaToolReplyMailbox,
  KafkaToolReplyPublisher,
} from "../../../packages/event-log/src/tool-replies.ts";
import { KafkaLogConsumer } from "../../../packages/event-log/src/kafka-log-consumer.ts";

const fixture = await testKafka({});
const bootId = randomUUID();
const mailbox = new KafkaToolReplyMailbox({ brokers: fixture.brokers, replicas: 3, bootId });
const publisher = new KafkaToolReplyPublisher(fixture.brokers, "reply-review-" + bootId);
let competitor,
  competitorJoined = false,
  seen = 0,
  callbacks = 0;
const counts = new Map();
const accept = mailbox.accept.bind(mailbox);
mailbox.accept = (value) => {
  seen++;
  counts.set(value.operationId, (counts.get(value.operationId) ?? 0) + 1);
  accept(value);
};
async function until(check) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Isolated rebalance did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const message = (id) => ({
  kind: "tool_result",
  operationId: id,
  sequence: 1,
  result: {
    toolCallId: "call",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "x".repeat(16384) }] },
  },
});
let report;
try {
  await mailbox.start();
  await publisher.start();
  const old = mailbox
    .wait("old", "call", "bash", new AbortController().signal)
    .then(() => callbacks++);
  await Promise.all(
    Array.from({ length: 100 }, (_, n) =>
      publisher.publish(mailbox.topic, message(n === 99 ? "old" : "retired-" + n)),
    ),
  );
  await old;
  await until(() => seen === 100);
  const before = seen;
  competitor = new KafkaLogConsumer({
    brokers: fixture.brokers,
    topic: mailbox.topic,
    clientId: "reply-review-rebalance-" + bootId,
    groupId: "tool-reply-" + bootId,
    commitMessages: false,
    decode: (value) => JSON.parse(value.toString()),
    onAssigned: async () => {
      competitorJoined = true;
    },
    handler: async () => {},
  });
  await competitor.start();
  await until(() => competitorJoined);
  await competitor.close();
  competitor = undefined;
  await until(() => seen >= 200);
  const replayedBeforeNext = seen - before;
  const fresh = mailbox
    .wait("new", "call", "bash", new AbortController().signal)
    .then(() => callbacks++);
  await publisher.publish(mailbox.topic, message("new"));
  await fresh;
  assert.equal(callbacks, 2);
  assert((counts.get("old") ?? 0) >= 2);
  assert.equal(mailbox.size, 0);
  report = {
    baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    scope:
      "Isolated pinned Kafka RF3. A temporary same-group reader forces actual group reassignment; original Worker mailbox object and waiters remain in memory.",
    firstPassRecords: before,
    textBytesPerRecord: 16384,
    replayedBeforeNext,
    oldReplyDeliveries: counts.get("old"),
    callbacksSettled: callbacks,
    finalMailboxSize: mailbox.size,
    limitation:
      "A group reassignment is exercised, not production network failure or fleet latency. No duplicate command execution occurs.",
  };
} finally {
  const cleanup = await Promise.allSettled([
    competitor?.close(),
    publisher.close(),
    mailbox.shutdown(),
  ]);
  await fixture.close();
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Review transport cleanup failed",
    );
}
report.fixtureCleaned = true;
writeFileSync(
  "docs/reports/kafka-worker-reply-rebalance-20261017.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
