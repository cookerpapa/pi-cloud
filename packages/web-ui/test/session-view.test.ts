import type {
  AcceptedTurnResource,
  PiCloudEvent,
  ConversationDetailResource,
  ProjectResource,
  SessionResource,
} from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import {
  activeTurn,
  createInitialSessionView,
  sessionViewReducer,
  type SessionViewState,
} from "../src/session-view.ts";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "20000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-19T00:00:00.000Z";

const project: ProjectResource = {
  projectId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "40000000-0000-4000-8000-000000000001",
  name: "Java repair demo",
  createdAt: CREATED_AT,
  source: { kind: "sample_java", status: "ready" },
  environment: {
    environmentVersionId: "30000000-0000-4000-8000-000000000002",
    versionNumber: 1,
    profileKey: "pi-cloud-fullstack",
    profileVersion: "1",
    imageRevision: "development",
    specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
    recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
    recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    state: "pending",
    active: true,
    createdAt: CREATED_AT,
  },
};

const session: SessionResource = {
  sessionId: SESSION_ID,
  title: "修复订单服务",
  projectId: project.projectId,
  workspaceId: project.workspaceId,
  workspaceState: "attached",
  state: "cold",
  executionMode: "elastic",
  sandboxProfileKey: "standard",
  workingDirectory: "/workspace",
  modelProfileId: "50000000-0000-4000-8000-000000000001",
  createdAt: CREATED_AT,
};

const accepted: AcceptedTurnResource = {
  turnId: TURN_ID,
  sessionId: SESSION_ID,
  runId: "50000000-0000-4000-8000-000000000002",
  mailboxPosition: 1,
  state: "queued",
  acceptedAt: CREATED_AT,
  replayed: false,
};

function envelope<Event extends PiCloudEvent>(
  sequence: number,
  value: Omit<
    Event,
    "schemaVersion" | "eventId" | "sessionId" | "turnId" | "agentId" | "seq" | "occurredAt"
  > &
    Partial<Pick<Event, "turnId">>,
): PiCloudEvent {
  return {
    schemaVersion: 1,
    eventId: `70000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION_ID,
    turnId: value.turnId ?? TURN_ID,
    agentId: "root",
    seq: sequence,
    occurredAt: CREATED_AT,
    type: value.type,
    payload: value.payload,
  } as PiCloudEvent;
}

function preparedState(): SessionViewState {
  let state = sessionViewReducer(createInitialSessionView(), {
    type: "session.created",
    project,
    session,
  });
  state = sessionViewReducer(state, {
    type: "turn.accepted",
    accepted,
    prompt: "Repair the test",
  });
  return state;
}

describe("session transcript reducer", () => {
  it("keeps durable mailbox positions for queued follow-ups", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "turn.accepted",
      accepted: {
        ...accepted,
        turnId: "20000000-0000-4000-8000-000000000002",
        mailboxPosition: 2,
      },
      prompt: "Run the follow-up checks",
    });

    expect(state.turns.map((turn) => [turn.mailboxPosition, turn.prompt, turn.status])).toEqual([
      [1, "Repair the test", "queued"],
      [2, "Run the follow-up checks", "queued"],
    ]);
    expect(activeTurn(state)?.mailboxPosition).toBe(1);
  });

  it("loads bounded historical prompt metadata before replaying its durable suffix", () => {
    const conversation: ConversationDetailResource = {
      project,
      inheritedMessages: [],
      session: {
        ...session,
        state: "running",
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      turns: [
        {
          turnId: TURN_ID,
          runId: accepted.runId,
          mailboxPosition: 8,
          prompt: "Historical private prompt",
          state: "running",
          acceptedAt: CREATED_AT,
        },
      ],
      historyTruncated: true,
    };
    let state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation,
    });
    expect(state).toMatchObject({
      sessionState: "running",
      historyTruncated: true,
      turns: [{ prompt: "Historical private prompt", mailboxPosition: 8, status: "running" }],
    });
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(11, { type: "assistant.text.delta", payload: { text: "continued" } }),
    });
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({ kind: "text", text: "continued" }),
    ]);
  });

  it("hydrates an active durable snapshot before following later SSE events", () => {
    const conversation: ConversationDetailResource = {
      project,
      inheritedMessages: [],
      session: {
        ...session,
        state: "running",
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      turns: [
        {
          turnId: TURN_ID,
          runId: accepted.runId,
          mailboxPosition: 1,
          prompt: "Long-running repair",
          state: "running",
          acceptedAt: CREATED_AT,
        },
      ],
      historyTruncated: false,
    };
    let state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation,
      liveEvents: [
        envelope(9, { type: "assistant.text.delta", payload: { text: "Already durable." } }),
      ],
    });
    expect(state).toMatchObject({
      turns: [
        {
          status: "running",
          items: [{ text: "Already durable.", recoveredTextLength: "Already durable.".length }],
        },
      ],
    });
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(10, { type: "assistant.text.delta", payload: { text: " Next." } }),
    });
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        text: "Already durable. Next.",
        lastSequence: 10,
        recoveredTextLength: "Already durable.".length,
      }),
    ]);
  });

  it("keeps a Turn accepted between the canonical and live snapshot reads", () => {
    const liveTurnId = "20000000-0000-4000-8000-000000000009";
    const state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation: {
        project,
        inheritedMessages: [],
        session: {
          ...session,
          state: "running",
          updatedAt: CREATED_AT,
          lastActiveAt: CREATED_AT,
        },
        turns: [],
        historyTruncated: false,
      },
      liveEvents: [
        {
          ...envelope(8, {
            type: "assistant.text.delta",
            payload: { text: "Cross-request race" },
          }),
          turnId: liveTurnId,
        },
      ],
    });

    expect(state).toMatchObject({
      turns: [{ turnId: liveTurnId, status: "running", items: [{ text: "Cross-request race" }] }],
    });
  });

  it("hydrates a completed semantic transcript without replaying historical deltas", () => {
    const conversation: ConversationDetailResource = {
      project,
      inheritedMessages: [],
      session: {
        ...session,
        state: "idle",
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      turns: [
        {
          turnId: TURN_ID,
          runId: accepted.runId,
          mailboxPosition: 1,
          prompt: "Historical projected prompt",
          state: "completed",
          transcript: {
            schemaVersion: 1,
            throughSequence: 6,
            items: [
              {
                kind: "text",
                text: "Inspecting tests.",
                firstSequence: 2,
                lastSequence: 3,
              },
              {
                kind: "tool",
                toolCallId: "call-1",
                toolName: "bash",
                input: { command: "npm test" },
                output: "all green",
                status: "completed",
                firstSequence: 4,
                lastSequence: 5,
                startedAt: CREATED_AT,
                completedAt: CREATED_AT,
              },
            ],
            startedSequence: 1,
            terminalSequence: 6,
            stopReason: "stop",
            failure: null,
            cancellation: null,
          },
          acceptedAt: CREATED_AT,
        },
      ],
      historyTruncated: false,
    };
    const state = sessionViewReducer(createInitialSessionView(), {
      type: "conversation.loaded",
      conversation,
    });

    expect(state.turns[0]).toMatchObject({
      status: "completed",
      startedSequence: 1,
      terminalSequence: 6,
      stopReason: "stop",
      items: [
        { kind: "text", key: "text:2", text: "Inspecting tests." },
        { kind: "tool", key: "tool:call-1", output: "all green" },
      ],
    });
  });

  it("keeps ordered text/tool lifecycle through terminal completion", () => {
    const events: PiCloudEvent[] = [
      envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
      envelope(2, { type: "assistant.text.delta", payload: { text: "Inspecting " } }),
      envelope(3, { type: "assistant.text.delta", payload: { text: "tests." } }),
      envelope(4, {
        type: "tool.started",
        payload: { toolCallId: "call-1", toolName: "bash", input: { command: "mvn test" } },
      }),
      envelope(5, {
        type: "tool.completed",
        payload: { toolCallId: "call-1", outcome: "completed", output: "1 test failed" },
      }),
      envelope(6, {
        type: "turn.completed",
        payload: { stopReason: "stop" },
      }),
    ];
    const state = events.reduce(
      (current, value) => sessionViewReducer(current, { type: "stream.event", event: value }),
      preparedState(),
    );

    expect(state.sessionState).toBe("idle");
    expect(state.turns[0]).toMatchObject({
      status: "completed",
      stopReason: "stop",
    });
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        kind: "text",
        text: "Inspecting tests.",
        firstSequence: 2,
        lastSequence: 3,
      }),
      expect.objectContaining({
        kind: "tool",
        toolName: "bash",
        status: "completed",
        firstSequence: 4,
        lastSequence: 5,
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
      }),
    ]);
  });

  it("marks an in-flight Tool unknown when its Run fails", () => {
    const events: PiCloudEvent[] = [
      envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
      envelope(2, {
        type: "tool.started",
        payload: { toolCallId: "call-unknown", toolName: "bash", input: { command: "deploy" } },
      }),
      envelope(3, {
        type: "turn.failed",
        payload: { code: "worker_lost", message: "Worker connection was lost", retryable: true },
      }),
    ];
    const state = events.reduce(
      (current, value) => sessionViewReducer(current, { type: "stream.event", event: value }),
      preparedState(),
    );
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({ kind: "tool", toolCallId: "call-unknown", status: "unknown" }),
    ]);
  });

  it("keeps Pi compaction and model retry events in the live transcript", () => {
    const events: PiCloudEvent[] = [
      envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
      envelope(2, { type: "context.compaction.started", payload: { reason: "threshold" } }),
      envelope(3, {
        type: "context.compaction.completed",
        payload: {
          reason: "threshold",
          status: "completed",
          willRetry: true,
          tokensBefore: 80_000,
          estimatedTokensAfter: 20_000,
        },
      }),
      envelope(4, {
        type: "model.sampling.retry.scheduled",
        payload: {
          stepSequence: 1,
          stepSha256: "a".repeat(64),
          completedSamplingAttempt: 1,
          nextSamplingAttempt: 2,
          maximumSamplingAttempts: 3,
          delayMs: 500,
        },
      }),
    ];
    const state = events.reduce(
      (current, value) => sessionViewReducer(current, { type: "stream.event", event: value }),
      preparedState(),
    );
    expect(state.turns[0]?.items).toEqual([
      expect.objectContaining({
        kind: "compaction",
        key: "compaction:2",
        status: "completed",
        firstSequence: 2,
        lastSequence: 3,
      }),
      expect.objectContaining({
        kind: "retry",
        key: "retry:4",
        nextSamplingAttempt: 2,
      }),
    ]);
  });

  it("marks cancellation intent before terminal confirmation", () => {
    let state = preparedState();
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
    });
    state = sessionViewReducer(state, {
      type: "turn.cancellation.requested",
      turnId: TURN_ID,
    });
    expect(state.turns[0]?.status).toBe("cancelling");
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(2, {
        type: "turn.cancelled",
        payload: { reason: "user_request", forced: false },
      }),
    });
    expect(state.turns[0]).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "user_request", forced: false },
    });
  });

  it("reconciles a provisioning failure even when no session event was published", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "run.reconciled",
      run: {
        runId: accepted.runId,
        state: "failed",
        failure: {
          code: "workspace_seed_unavailable",
          message: "Workspace source could not be provisioned",
          retryable: true,
        },
      },
    });

    expect(activeTurn(state)).toBeUndefined();
    expect(state.sessionState).toBe("idle");
    expect(state.turns[0]).toMatchObject({
      runId: accepted.runId,
      status: "failed",
      failure: { code: "workspace_seed_unavailable" },
    });
  });

  it("does not let Run polling terminate an active SSE transcript", () => {
    let state = preparedState();
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(1, { type: "turn.started", payload: { inputKind: "prompt" } }),
    });
    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(2, { type: "assistant.text.delta", payload: { text: "still streaming" } }),
    });

    state = sessionViewReducer(state, {
      type: "run.reconciled",
      run: {
        runId: accepted.runId,
        state: "completed",
        stopReason: "stop",
      },
    });
    expect(state.turns[0]).toMatchObject({
      status: "running",
      items: [expect.objectContaining({ kind: "text", text: "still streaming" })],
    });

    state = sessionViewReducer(state, {
      type: "stream.event",
      event: envelope(3, { type: "turn.completed", payload: { stopReason: "stop" } }),
    });
    expect(state.turns[0]).toMatchObject({ status: "completed", terminalSequence: 3 });
  });

  it("renders Gateway-ordered events without keeping a browser cursor", () => {
    const state = sessionViewReducer(preparedState(), {
      type: "stream.event",
      event: envelope(2, { type: "assistant.text.delta", payload: { text: "gap" } }),
    });
    expect(state.turns[0]?.items).toEqual([expect.objectContaining({ kind: "text", text: "gap" })]);
  });

  it("ignores a late callback from a previously selected session", () => {
    const state = preparedState();
    const lateEvent = {
      ...envelope(1, { type: "assistant.text.delta", payload: { text: "late" } }),
      sessionId: "90000000-0000-4000-8000-000000000001",
    } as PiCloudEvent;
    expect(sessionViewReducer(state, { type: "stream.event", event: lateEvent })).toBe(state);
  });
});
