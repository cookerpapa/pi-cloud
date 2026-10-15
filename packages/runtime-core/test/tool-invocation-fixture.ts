import { createExecutionReference, type CandidateToolCommand } from "@pi-cloud/protocol";
import type {
  AcceptedDurableCommitFact,
  ExecutionPublication,
  DurableCubeToolDispatch,
} from "../src/accepted-fact.ts";
import type { DurableCommitPublication } from "@pi-cloud/protocol";

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
    piConversationId: 1,
  } satisfies ExecutionPublication["scope"];
  const args = { path: "large.txt", content };
  const command: CandidateToolCommand = {
    executionReference,
    toolCallId: "task:4",
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

      timeoutMs: 60000,
      maximumOutputBytes: 65536,
    },
  };
  const { leaseId: _lease, piConversationId: _conversation, ...identity } = scope;
  const publication: DurableCommitPublication & {
    tools: { taskId: number; command: CandidateToolCommand }[];
  } = {
    commit: {
      seq: 8,
      nextId: 5,
      writes: [
        {
          type: "task",
          value: {
            id: 4,
            conversationId: 1,
            kind: "pi.tool",
            version: 1,
            input: { assistant: 2, callId: "provider-1" },
            owner: 3,
            background: false,
            abortRequested: false,
            state: {
              status: "running",
              checkpoint: { phase: "execute", arguments: args, replay: "unsafe" },
            },
          },
        },
      ],
    },
    origins: [{ recordId: 4, sessionId: scope.sessionId, runId, turnId: scope.turnId }],
    tools: [{ taskId: 4, command }],
    cancellations: [],
    display: [],
  };
  const {
    args: _args,
    toolCallId: _providerId,
    ...request
  } = command.request as Extract<CandidateToolCommand["request"], { operation: "tool.execute" }>;
  const fact: AcceptedDurableCommitFact & { tools: DurableCubeToolDispatch[] } = {
    kind: "durable_commit",
    factId: "20000000-0000-4000-8000-000000000009",
    scope: identity,
    commit: publication.commit,
    origins: publication.origins,
    display: [],
    cancellations: [],
    tools: [
      {
        taskId: 4,
        target: "cube",
        scope: identity,
        request,
        replyTopic: command.replyTopic!,
        occurredAt: command.occurredAt,
      },
    ],
    occurredAt: command.occurredAt,
  };
  return { scope, executionReference, publication, command, fact };
}
