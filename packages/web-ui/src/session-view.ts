import type {
  AcceptedTurnResource,
  PiCloudEvent,
  ConversationDetailResource,
  ConversationSessionResource,
  ProjectResource,
  ProjectEnvironmentResource,
  RunResource,
  SessionState,
  SessionResource,
} from "@pi-cloud/protocol";
import type { SessionStreamStatus } from "./sse.ts";

export type TurnViewStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export type TranscriptItem =
  | {
      kind: "text";
      key: string;
      text: string;
      firstSequence: number;
      lastSequence: number;
      /** Text recovered before this browser attached; render it without replay animation. */
      recoveredTextLength?: number;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      status: "running" | "completed" | "failed" | "unknown";
      firstSequence: number;
      lastSequence?: number;
      startedAt: string;
      completedAt?: string;
    }
  | {
      kind: "notification";
      key: string;
      level: "info" | "warning" | "error";
      message: string;
      sequence: number;
    }
  | {
      kind: "compaction";
      key: string;
      reason: "manual" | "threshold" | "overflow";
      status: "running" | "completed" | "aborted" | "failed";
      willRetry: boolean;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
      firstSequence: number;
      lastSequence?: number;
    }
  | {
      kind: "retry";
      key: string;
      nextSamplingAttempt: number;
      maximumSamplingAttempts?: number;
      delayMs?: number;
      sequence: number;
    };

export type TurnView = {
  runId: string | null;
  turnId: string;
  mailboxPosition: number | null;
  prompt: string;
  acceptedAt: string | null;
  status: TurnViewStatus;
  items: readonly TranscriptItem[];
  startedSequence: number | null;
  terminalSequence: number | null;
  stopReason: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  cancellation: { reason: string; forced: boolean } | null;
};

export type ConnectionView =
  | { phase: "offline"; attempt: 0; message: string | null }
  | {
      phase: SessionStreamStatus["phase"];
      attempt: number;
      message: string | null;
      retryInMs: number | null;
    };

export type SessionViewStatus = "none" | SessionState;

export type SessionViewState = {
  project: ProjectResource | null;
  session: SessionResource | ConversationSessionResource | null;
  sessionState: SessionViewStatus;
  inheritedMessages: ConversationDetailResource["inheritedMessages"];
  turns: readonly TurnView[];
  historyTruncated: boolean;
  connection: ConnectionView;
  apiError: string | null;
};

export type SessionViewAction =
  | { type: "session.created"; project: ProjectResource; session: SessionResource }
  | {
      type: "conversation.loaded";
      conversation: ConversationDetailResource;
      liveEvents?: readonly PiCloudEvent[];
    }
  | { type: "project.environment.refreshed"; environment: ProjectEnvironmentResource }
  | { type: "turn.accepted"; accepted: AcceptedTurnResource; prompt: string }
  | { type: "turn.cancellation.requested"; turnId: string }
  | {
      type: "run.reconciled";
      run: Pick<RunResource, "runId" | "state" | "stopReason" | "failure">;
    }
  | { type: "stream.status"; status: SessionStreamStatus }
  | { type: "stream.event"; event: PiCloudEvent }
  | { type: "api.error"; message: string }
  | { type: "api.error.cleared" };

export function createInitialSessionView(): SessionViewState {
  return {
    project: null,
    session: null,
    sessionState: "none",
    inheritedMessages: [],
    turns: [],
    historyTruncated: false,
    connection: { phase: "offline", attempt: 0, message: null },
    apiError: null,
  };
}

function unknownTurn(turnId: string): TurnView {
  return {
    runId: null,
    turnId,
    mailboxPosition: null,
    prompt: "Input was accepted before this browser connected.",
    acceptedAt: null,
    status: "running",
    items: [],
    startedSequence: null,
    terminalSequence: null,
    stopReason: null,
    failure: null,
    cancellation: null,
  };
}

function updateTurn(
  turns: readonly TurnView[],
  turnId: string,
  update: (turn: TurnView) => TurnView,
): readonly TurnView[] {
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  if (index < 0) return [...turns, update(unknownTurn(turnId))];
  return turns.map((turn, current) => (current === index ? update(turn) : turn));
}

function appendText(turn: TurnView, text: string, sequence: number): TurnView {
  const items = [...turn.items];
  const last = items.at(-1);
  if (last?.kind === "text") {
    items[items.length - 1] = {
      ...last,
      text: `${last.text}${text}`,
      lastSequence: sequence,
    };
  } else {
    items.push({
      kind: "text",
      key: `text:${String(sequence)}`,
      text,
      firstSequence: sequence,
      lastSequence: sequence,
    });
  }
  return { ...turn, status: "running", items };
}

function transcriptItem(
  item: NonNullable<ConversationDetailResource["turns"][number]["transcript"]>["items"][number],
  recovered = false,
): TranscriptItem {
  if (item.kind === "text") {
    return {
      ...item,
      key: `text:${String(item.firstSequence)}`,
      ...(recovered ? { recoveredTextLength: item.text.length } : {}),
    };
  }
  if (item.kind === "tool") {
    return { ...item, key: `tool:${item.toolCallId}` };
  }
  if (item.kind === "notification") {
    return { ...item, key: `notification:${String(item.sequence)}` };
  }
  if (item.kind === "compaction") {
    return { ...item, key: `compaction:${String(item.firstSequence)}` };
  }
  return { ...item, key: `retry:${String(item.sequence)}` };
}

function applyEvent(state: SessionViewState, event: PiCloudEvent): SessionViewState {
  if (state.session !== null && event.sessionId !== state.session.sessionId) return state;
  if (event.type === "session.state.changed") {
    return { ...state, sessionState: event.payload.to };
  }
  if (event.turnId === null) return state;

  const turns = updateTurn(state.turns, event.turnId, (turn) => {
    if (event.type === "turn.started") {
      return {
        ...turn,
        status: "running",
        startedSequence: event.seq,
        failure: null,
        cancellation: null,
      };
    }
    if (event.type === "assistant.text.delta") {
      return appendText(turn, event.payload.text, event.seq);
    }
    if (event.type === "tool.started") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "tool" || item.toolCallId !== event.payload.toolCallId) return item;
        matched = true;
        return {
          ...item,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          startedAt: event.occurredAt,
        };
      });
      if (!matched) {
        items.push({
          kind: "tool",
          key: `tool:${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      }
      return {
        ...turn,
        status: "running",
        items,
      };
    }
    if (event.type === "tool.completed") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "tool" || item.toolCallId !== event.payload.toolCallId) return item;
        matched = true;
        return {
          ...item,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          lastSequence: event.seq,
          completedAt: event.occurredAt,
        };
      });
      if (!matched) {
        items.push({
          kind: "tool",
          key: `tool:${event.payload.toolCallId}`,
          toolCallId: event.payload.toolCallId,
          toolName: "unknown",
          input: null,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          firstSequence: event.seq,
          lastSequence: event.seq,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
        });
      }
      return { ...turn, items };
    }
    if (event.type === "ui.notification") {
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "notification",
            key: `notification:${String(event.seq)}`,
            level: event.payload.level,
            message: event.payload.message,
            sequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "context.compaction.started") {
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "compaction",
            key: `compaction:${String(event.seq)}`,
            reason: event.payload.reason,
            status: "running",
            willRetry: false,
            firstSequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "context.compaction.completed") {
      let index = -1;
      for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const candidate = turn.items[itemIndex]!;
        if (candidate.kind === "compaction" && candidate.status === "running") {
          index = itemIndex;
          break;
        }
      }
      const existing = index < 0 ? undefined : turn.items[index];
      const completed: TranscriptItem = {
        kind: "compaction",
        key: existing?.kind === "compaction" ? existing.key : `compaction:${String(event.seq)}`,
        reason: event.payload.reason,
        status: event.payload.status,
        willRetry: event.payload.willRetry,
        ...(event.payload.tokensBefore === undefined
          ? {}
          : { tokensBefore: event.payload.tokensBefore }),
        ...(event.payload.estimatedTokensAfter === undefined
          ? {}
          : { estimatedTokensAfter: event.payload.estimatedTokensAfter }),
        firstSequence: existing?.kind === "compaction" ? existing.firstSequence : event.seq,
        lastSequence: event.seq,
      };
      if (index < 0) return { ...turn, items: [...turn.items, completed] };
      return {
        ...turn,
        items: turn.items.map((item, itemIndex) => (itemIndex === index ? completed : item)),
      };
    }
    if (event.type === "model.sampling.retry.scheduled") {
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "retry",
            key: `retry:${String(event.seq)}`,
            nextSamplingAttempt: event.payload.nextSamplingAttempt,
            maximumSamplingAttempts: event.payload.maximumSamplingAttempts,
            delayMs: event.payload.delayMs,
            sequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "turn.completed") {
      return {
        ...turn,
        status: "completed",
        terminalSequence: event.seq,
        stopReason: event.payload.stopReason,
      };
    }
    if (event.type === "turn.failed") {
      return {
        ...turn,
        items: turn.items.map((item): TranscriptItem => {
          if (item.kind === "tool" && item.status === "running") {
            return {
              ...item,
              status: "unknown",
              lastSequence: event.seq,
              completedAt: event.occurredAt,
            };
          }
          if (item.kind === "compaction" && item.status === "running") {
            return { ...item, status: "failed", lastSequence: event.seq };
          }
          return item;
        }),
        status: "failed",
        terminalSequence: event.seq,
        failure: event.payload,
      };
    }
    if (event.type === "turn.cancelled") {
      return {
        ...turn,
        items: turn.items.map((item): TranscriptItem => {
          if (item.kind === "tool" && item.status === "running") {
            return {
              ...item,
              status: "unknown",
              lastSequence: event.seq,
              completedAt: event.occurredAt,
            };
          }
          if (item.kind === "compaction" && item.status === "running") {
            return { ...item, status: "aborted", lastSequence: event.seq };
          }
          return item;
        }),
        status: "cancelled",
        terminalSequence: event.seq,
        stopReason: "cancelled",
        cancellation: event.payload,
      };
    }
    return turn;
  });

  const terminal =
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled";
  return {
    ...state,
    turns,
    sessionState: terminal
      ? "idle"
      : event.type === "turn.started"
        ? "running"
        : state.sessionState,
  };
}

export function sessionViewReducer(
  state: SessionViewState,
  action: SessionViewAction,
): SessionViewState {
  if (action.type === "session.created") {
    return {
      ...createInitialSessionView(),
      project: action.project,
      session: action.session,
      sessionState: action.session.state,
      connection: { phase: "offline", attempt: 0, message: "Opening durable event stream" },
    };
  }
  if (action.type === "conversation.loaded") {
    const loaded: SessionViewState = {
      ...createInitialSessionView(),
      project: action.conversation.project,
      session: action.conversation.session,
      sessionState: action.conversation.session.state,
      inheritedMessages: action.conversation.inheritedMessages,
      turns: action.conversation.turns.map((turn): TurnView => ({
        ...(turn.transcript === undefined
          ? {
              items: [],
              startedSequence: null,
              terminalSequence: null,
              stopReason: null,
              failure:
                turn.state === "failed"
                  ? {
                      code: "run_failed",
                      message: "这次运行失败了，请重试。",
                      retryable: true,
                    }
                  : null,
              cancellation:
                turn.state === "cancelled" ? { reason: "cancelled", forced: false } : null,
            }
          : {
              items: turn.transcript.items.map((item) => transcriptItem(item)),
              startedSequence: turn.transcript.startedSequence,
              terminalSequence: turn.transcript.terminalSequence,
              stopReason: turn.transcript.stopReason,
              failure: turn.transcript.failure,
              cancellation: turn.transcript.cancellation,
            }),
        runId: turn.runId,
        turnId: turn.turnId,
        mailboxPosition: turn.mailboxPosition,
        prompt: turn.prompt,
        acceptedAt: turn.acceptedAt,
        status: turn.state,
      })),
      historyTruncated: action.conversation.historyTruncated,
      connection: { phase: "offline", attempt: 0, message: "Opening durable event stream" },
    };
    const withLiveEvents = (action.liveEvents ?? []).reduce(applyEvent, loaded);
    return {
      ...withLiveEvents,
      turns: withLiveEvents.turns.map((turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === "text" ? { ...item, recoveredTextLength: item.text.length } : item,
        ),
      })),
    };
  }
  if (action.type === "project.environment.refreshed") {
    return state.project === null
      ? state
      : { ...state, project: { ...state.project, environment: action.environment } };
  }
  if (action.type === "turn.accepted") {
    const turns = updateTurn(state.turns, action.accepted.turnId, (turn) => ({
      ...turn,
      runId: action.accepted.runId,
      mailboxPosition: action.accepted.mailboxPosition,
      prompt: action.prompt,
      acceptedAt: action.accepted.acceptedAt,
      status: turn.startedSequence === null ? "queued" : turn.status,
    }));
    return { ...state, turns, apiError: null };
  }
  if (action.type === "run.reconciled") {
    const turns = state.turns.map((turn): TurnView => {
      if (turn.runId !== action.run.runId) return turn;
      if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
        return turn;
      }
      if (action.run.state === "completed") {
        // Once the durable event stream has started this Turn, its ordered
        // terminal event is the only authority allowed to end presentation.
        // Completing from the polling fallback would set streaming=false and
        // flush the remaining progressive text before SSE reaches the browser.
        if (turn.startedSequence !== null) return turn;
        return {
          ...turn,
          status: "completed",
          stopReason: action.run.stopReason ?? "stop",
        };
      }
      if (action.run.state === "cancelled") {
        return {
          ...turn,
          status: "cancelled",
          stopReason: "cancelled",
          cancellation: { reason: "cancelled", forced: false },
        };
      }
      if (
        action.run.state === "failed" ||
        action.run.state === "timed_out" ||
        action.run.state === "superseded"
      ) {
        return {
          ...turn,
          status: "failed",
          failure:
            action.run.failure === undefined
              ? action.run.state === "timed_out"
                ? { code: "run_timed_out", message: "运行超时，请重试。", retryable: true }
                : { code: "run_failed", message: "这次运行失败了，请重试。", retryable: true }
              : {
                  ...action.run.failure,
                  message: action.run.failure.message ?? "这次运行失败了，请重试。",
                },
        };
      }
      if (action.run.state === "cancel_requested") return { ...turn, status: "cancelling" };
      if (action.run.state === "running" || action.run.state === "checkpointing") {
        return { ...turn, status: "running" };
      }
      return { ...turn, status: "queued" };
    });
    const hasActiveTurn = turns.some(
      (turn) =>
        turn.status === "queued" || turn.status === "running" || turn.status === "cancelling",
    );
    return {
      ...state,
      turns,
      sessionState: hasActiveTurn ? state.sessionState : "idle",
    };
  }
  if (action.type === "turn.cancellation.requested") {
    return {
      ...state,
      turns: updateTurn(state.turns, action.turnId, (turn) => ({
        ...turn,
        status: turn.status === "running" ? "cancelling" : turn.status,
      })),
      apiError: null,
    };
  }
  if (action.type === "stream.status") {
    return {
      ...state,
      connection: {
        phase: action.status.phase,
        attempt: action.status.attempt,
        message: action.status.message ?? null,
        retryInMs: action.status.retryInMs ?? null,
      },
    };
  }
  if (action.type === "stream.event") return applyEvent(state, action.event);
  if (action.type === "api.error") return { ...state, apiError: action.message };
  return { ...state, apiError: null };
}

export function activeTurn(state: SessionViewState): TurnView | undefined {
  return state.turns.find(
    (turn) => turn.status === "queued" || turn.status === "running" || turn.status === "cancelling",
  );
}
