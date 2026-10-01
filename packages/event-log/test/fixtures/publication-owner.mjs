import native from "@confluentinc/kafka-javascript";
import { KafkaLogConsumer } from "../../src/kafka-log-consumer.ts";

const { brokers, topic, groupId } = JSON.parse(process.env.PI_PUBLICATION_FIXTURE);
let pause = false,
  writer;
const produce = native.Producer.prototype.produce;
native.Producer.prototype.produce = function (...args) {
  if (pause) {
    pause = false;
    process.send({ type: "paused-before-produce" });
    // The small IPC message is queued before this synchronous stop.
    process.kill(process.pid, "SIGSTOP");
  }
  return produce.apply(this, args);
};
const consumer = new KafkaLogConsumer({
  brokers,
  topic,
  groupId,
  clientId: `${topic}-old`,
  groupRecovery: true,
  orderedEffects: true,
  decode: (bytes) => JSON.parse(bytes.toString()),
  handler: async () => {},
  onAssigned: async (partitions, current) => {
    if (partitions.includes(0)) writer = await consumer.openPublicationWriter(0, current);
  },
  onRevoked: () => {
    void writer?.close().catch(() => {});
  },
});
process.on("message", async (message) => {
  if (message.type !== "pause-and-publish") return;
  pause = true;
  try {
    await writer.append({
      factId: "stale",
      sessionId: "session",
      value: JSON.stringify({ id: "stale" }),
    });
    process.send({ type: "unexpected-commit" });
  } catch {
    process.send({ type: "rejected" });
  }
});
await consumer.start();
await consumer.waitUntilAssigned(30_000);
process.send({ type: "ready" });
