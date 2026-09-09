// Private process-fault fixture: real group consumer and real HTTP forwarding.
import { randomUUID } from "node:crypto";
import {
  KafkaToolCommandConsumer,
  httpToolLogDelivery,
} from "../packages/tool-broker/src/kafka-tool-command-consumer.ts";
const input = await new Promise((resolve) => process.once("message", resolve));
const pending = new Map(),
  partitions = new Map();
let freezeOperation;
function query(kind, value) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    process.send({ type: "query", id, kind, value });
  });
}
const forward = httpToolLogDelivery(input.token);
const router = new KafkaToolCommandConsumer({
  brokers: input.brokers,
  topic: input.topic,
  groupId: input.groupId,
  routes: {
    find: (scope, wholeWriter) => query("find", { scope, wholeWriter }),
    isAlive: (instanceId) => query("alive", { instanceId }),
  },
  deliver: async (route, delivery) => {
    await forward(route, delivery);
    if (freezeOperation && delivery.fact.request?.operationId === freezeOperation) {
      process.send({ type: "frozen", operationId: freezeOperation });
      await new Promise(() => {});
    }
  },
});
const consume = router.consume.bind(router);
router.consume = async (record) => {
  partitions.set(record.partition, (partitions.get(record.partition) ?? 0) + 1);
  return consume(record);
};
process.on("message", (message) => {
  if (message.type === "answer") {
    pending.get(message.id)?.(message.value);
    pending.delete(message.id);
  }
  if (message.type === "freeze") freezeOperation = message.operationId;
  if (message.type === "stats")
    process.send({
      type: "stats",
      id: message.id,
      statistics: router.statistics(),
      partitions: Object.fromEntries(partitions),
    });
});
process.once("SIGTERM", () => void router.close().then(() => process.exit(0)));
await router.start();
process.send({ type: "ready" });
