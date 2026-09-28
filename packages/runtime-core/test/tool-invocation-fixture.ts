import { createExecutionReference, type CandidateToolCommand } from "@pi-cloud/protocol";
import type { CandidatePiSessionAppendFact, ExecutionPublication } from "../src/accepted-fact.ts";
import { prepareExecutionFact } from "../src/prepare-execution-fact.ts";

export function toolInvocationFixture(content = "hello") {
  const runId = "20000000-0000-4000-8000-000000000001";
  const leaseId = "20000000-0000-4000-8000-000000000002";
  const executionReference = createExecutionReference(leaseId, runId, 3);
  const scope = {
    tenantId: "20000000-0000-4000-8000-000000000003",
    sessionId: "20000000-0000-4000-8000-000000000004",
    turnId: "20000000-0000-4000-8000-000000000005",
    piSessionId: "20000000-0000-4000-8000-000000000006",
    runId,
    leaseId,
    writerId: leaseId,
    fencingToken: 3,
    piSessionLane: "main",
  } satisfies ExecutionPublication["scope"];
  const args = { path: "large.txt", content };
  const command: CandidateToolCommand = {
    executionReference,
    toolCallId: "result-1",
    replyTopic: "reply-worker-boot",
    occurredAt: "2026-09-28T00:00:00.000Z",
    request: {
      type: "tool_sandbox.operation",
      toolBrokerProtocolVersion: 1,
      operation: "tool.execute",
      toolName: "write",
      toolCallId: "provider-1",
      args,
      activationId: "20000000-0000-4000-8000-000000000007",
      operationId: "20000000-0000-4000-8000-000000000008",
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      stepContextSha256: "c".repeat(64),
      stepContextSequence: 1,
      timeoutMs: 60000,
      maximumOutputBytes: 65536,
    },
  };
  const { leaseId: _lease, fencingToken: _fence, ...nativeScope } = scope;
  const mutation: CandidatePiSessionAppendFact = {
    schemaVersion: 1,
    mutationId: "mutation-1",
    scope: { ...nativeScope, executionReference },
    items: [
      {
        kind: "record",
        turnId: scope.turnId,
        record: {
          id: "intent-1",
          type: "tool_started",
          lane: "main",
          seq: 8,
          timestamp: 1,
          runId: "native-operation-1",
          assistantEntryId: "assistant-1",
          toolIndex: 0,
          toolCallId: "provider-1",
          toolName: "write",
          effectiveArgs: args,
          resultEntryId: "result-1",
          replay: "never",
        },
      },
    ],
    events: [
      {
        schemaVersion: 1,
        eventId: "20000000-0000-4000-8000-000000000009",
        agentId: "root",
        seq: 5,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        occurredAt: command.occurredAt,
        type: "tool.started",
        payload: { toolCallId: "result-1", toolName: "write", input: args },
      },
    ],
    occurredAt: command.occurredAt,
    toolCommand: command,
  };
  const fact = prepareExecutionFact(
    { ...scope, executionReference },
    { kind: "pi_session_append", mutation },
  );
  if (fact.kind !== "tool_invocation") throw new Error("Expected combined invocation");
  return { scope, executionReference, mutation, command, fact };
}
