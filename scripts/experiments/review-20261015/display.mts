import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DurableRunEvents } from "../../../packages/sandbox-supervisor/src/durable/run-events.ts";
import { toolInvocationFixture } from "../../../packages/runtime-core/test/tool-invocation-fixture.ts";
import { prepareExecutionFact } from "../../../packages/runtime-core/src/prepare-execution-fact.ts";
import { parseAcceptedFact } from "../../../packages/runtime-core/src/kafka-accepted-fact.ts";

const { fact, scope, executionReference } = toolInvocationFixture("x".repeat(80000));
const facts: any[] = [];
let sequence = 0;
const observer = new DurableRunEvents({
  emit: async (body) => {
    const at = new Date().toISOString();
    const event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      agentId: "root",
      seq: ++sequence,
      occurredAt: at,
      ...body,
    };
    const packed = prepareExecutionFact({ ...scope, executionReference }, {
      kind: "agent_event",
      publication: {
        protocolVersion: 1,
        messageId: randomUUID(),
        sentAt: at,
        type: "event.publish",
        payload: { executionReference, event },
      },
    } as any);
    facts.push(parseAcceptedFact(packed));
  },
  toolId: () => "task:4",
  maximumToolOutputBytes: 65536,
  retryAttempts: 4,
  task: async () => undefined,
});
const args = (fact.commit.writes[0]!.value as any).state.checkpoint.arguments;
await observer.consume([
  { type: "tool_execution_start", toolCallId: "provider-1", toolName: "write", args },
] as any);
const resultText = "y".repeat(16384);
const entry = {
  id: 6,
  conversationId: 1,
  kind: "pi.tool_result",
  model: [
    {
      role: "toolResult",
      toolName: "write",
      toolCallId: "provider-1",
      isError: false,
      content: [{ type: "text", text: resultText }],
      timestamp: Date.now(),
    },
  ],
};
await observer.consume([
  { type: "tool_execution_end", toolCallId: "provider-1", toolName: "write", entry },
] as any);
assert.equal(facts[0].event.payload.input.content, args.content);
assert.equal(facts[1].event.payload.output, resultText);
const output = {
  baseline: "c3aca045",
  kind: "real-presentation-adapter-synthetic-events",
  note: "Runs real DurableRunEvents, prepareExecutionFact and parser; no Kafka network or production state is used.",
  nativeExecuteArgumentBytes: Buffer.byteLength(args.content),
  copiedToolStartedArgumentBytes: Buffer.byteLength(facts[0].event.payload.input.content),
  toolStartedFactBytes: Buffer.byteLength(JSON.stringify(facts[0])),
  nativeToolResultTextBytes: Buffer.byteLength(resultText),
  copiedToolCompletedOutputBytes: Buffer.byteLength(facts[1].event.payload.output),
  toolCompletedFactBytes: Buffer.byteLength(JSON.stringify(facts[1])),
};
await writeFile(
  "/tmp/pi-cloud-projector-display-review-20261015.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify(output, null, 2));
