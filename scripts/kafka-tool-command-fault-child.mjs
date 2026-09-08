// Isolated process-fault fixture, never an application execution backend.
import { KafkaToolCommandConsumer } from "../packages/tool-broker/src/kafka-tool-command-consumer.ts";
import { createExecutionLease } from "@pi-cloud/protocol";

const input = await new Promise((resolve) => process.once("message", resolve));
const binding = input.command.request.activationId,
  scope = input.command.scope;
const lease = createExecutionLease(scope.leaseId, scope.attemptId, scope.fencingToken);
let effects = 0;
const consumer = new KafkaToolCommandConsumer({
  brokers: input.brokers,
  topic: input.topic,
  instanceId: input.boot,
  broker: {
    ownsToolBinding: (id) => id === binding,
    assertToolResultReader: (id, value) => {
      if (id !== binding || value !== lease) throw new Error("stale binding");
    },
    async execute(value, request) {
      if (value !== lease) throw new Error("stale execution");
      process.send({ type: "entered", operationId: request.operationId });
      if (input.hold) await new Promise((resolve) => setTimeout(resolve, 30000));
      effects++;
      process.send({ type: "effect", operationId: request.operationId });
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation_result",
        activationId: binding,
        operationId: request.operationId,
        operation: "bash.exec",
        exitCode: 0,
        outputChunks: [],
        outputSha256: "a".repeat(64),
      };
    },
  },
});
process.on("message", (message) => {
  if (message.type === "stats") process.send({ type: "stats", effects, ...consumer.statistics() });
});
process.once("SIGTERM", () => void consumer.close().then(() => process.exit(0)));
await consumer.start();
process.send({ type: "ready" });
