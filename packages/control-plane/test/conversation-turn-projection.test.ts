import { createPiCloudEventFactory, type PiCloudEventBody } from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { projectConversationTurnTranscript } from "@pi-cloud/runtime-core/conversation-turn-projection";

const CREATED_AT = "2026-07-23T00:00:00.000Z";

function events(bodies: readonly PiCloudEventBody[]) {
  let id = 0;
  const factory = createPiCloudEventFactory(
    {
      sessionId: "10000000-0000-4000-8000-000000000001",
      turnId: "20000000-0000-4000-8000-000000000001",
      agentId: "root",
    },
    {
      clock: () => new Date(CREATED_AT),
      idGenerator: () => `30000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    },
  );
  return bodies.map((body) => factory.next(body));
}

describe("conversation turn projection", () => {
  it("coalesces text while preserving tool, notification, and terminal semantics", () => {
    const projected = projectConversationTurnTranscript(
      events([
        { type: "turn.started", payload: { inputKind: "prompt" } },
        { type: "assistant.text.delta", payload: { text: "Inspecting " } },
        { type: "context.compaction.started", payload: { reason: "threshold" } },
        {
          type: "context.compaction.completed",
          payload: {
            reason: "threshold",
            status: "completed",
            willRetry: false,
            tokensBefore: 1_000,
            estimatedTokensAfter: 500,
          },
        },
        {
          type: "model.sampling.retry.scheduled",
          payload: {
            stepSequence: 1,
            stepSha256: "a".repeat(64),
            completedSamplingAttempt: 1,
            nextSamplingAttempt: 2,
            maximumSamplingAttempts: 3,
            delayMs: 1_500,
          },
        },
        { type: "assistant.text.delta", payload: { text: "the tests." } },
        {
          type: "tool.started",
          payload: { toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } },
        },
        {
          type: "tool.completed",
          payload: { toolCallId: "call-1", outcome: "completed", output: "all green" },
        },
        { type: "assistant.text.delta", payload: { text: "Done." } },
        {
          type: "ui.notification",
          payload: { level: "info", message: "Artifact ready" },
        },
        {
          type: "turn.completed",
          payload: {
            stopReason: "stop",
            workspacePatch: {
              format: "unified_diff",
              patch: "diff --git a/a b/a\n",
              truncated: false,
            },
          },
        },
      ]),
    );

    expect(projected).toMatchObject({
      schemaVersion: 1,
      throughSequence: 11,
      startedSequence: 1,
      terminalSequence: 11,
      stopReason: "stop",
      failure: null,
      cancellation: null,
      workspacePatch: { truncated: false },
    });
    expect(projected.items).toEqual([
      {
        kind: "text",
        text: "Inspecting ",
        firstSequence: 2,
        lastSequence: 2,
      },
      {
        kind: "compaction",
        reason: "threshold",
        status: "completed",
        willRetry: false,
        tokensBefore: 1_000,
        estimatedTokensAfter: 500,
        firstSequence: 3,
        lastSequence: 4,
      },
      {
        kind: "retry",
        nextSamplingAttempt: 2,
        maximumSamplingAttempts: 3,
        delayMs: 1_500,
        sequence: 5,
      },
      {
        kind: "text",
        text: "the tests.",
        firstSequence: 6,
        lastSequence: 6,
      },
      {
        kind: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "npm test" },
        output: "all green",
        status: "completed",
        firstSequence: 7,
        lastSequence: 8,
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
      },
      {
        kind: "text",
        text: "Done.",
        firstSequence: 9,
        lastSequence: 9,
      },
      {
        kind: "notification",
        level: "info",
        message: "Artifact ready",
        sequence: 10,
      },
    ]);
  });

  it("rejects mixed identities instead of projecting ambiguous history", () => {
    const projectedEvents = events([
      { type: "turn.started", payload: { inputKind: "prompt" } },
      { type: "assistant.text.delta", payload: { text: "hello" } },
    ]);
    projectedEvents[1] = {
      ...projectedEvents[1]!,
      turnId: "20000000-0000-4000-8000-000000000002",
    };
    expect(() => projectConversationTurnTranscript(projectedEvents)).toThrow(/share one identity/);
  });

  it("collapses a high-frequency completed stream into one semantic text item", () => {
    const deltas: PiCloudEventBody[] = Array.from({ length: 1_000 }, () => ({
      type: "assistant.text.delta",
      payload: { text: "x" },
    }));
    const projected = projectConversationTurnTranscript(
      events([
        { type: "turn.started", payload: { inputKind: "prompt" } },
        ...deltas,
        { type: "turn.completed", payload: { stopReason: "stop" } },
      ]),
    );

    expect(projected.throughSequence).toBe(1_002);
    expect(projected.items).toEqual([
      {
        kind: "text",
        text: "x".repeat(1_000),
        firstSequence: 2,
        lastSequence: 1_001,
      },
    ]);
  });
});
