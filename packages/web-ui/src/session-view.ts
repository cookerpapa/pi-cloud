import {
  emptyConversationHistory,
  HISTORY_LIVE_ITEMS,
  HISTORY_LIVE_CHARACTERS,
  type ConversationHistoryBoundary,
  type ConversationHistoryQuery,
} from "@pi-cloud/protocol";
import type { UserUpload } from "@pi-cloud/protocol";
import type {
  AcceptedTurnResource,
  InputQueueResource,
  AssistantMessagePhase,
  PiCloudEvent,
  ConversationDetailResource,
  ConversationSessionResource,
  ProjectResource,
  SessionState,
  SessionResource,
} from "@pi-cloud/protocol";
import type { SessionStreamStatus } from "./sse.ts";

export type TurnViewStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export type TranscriptItem = { historyCursor?: string; pageKey?: string } & (
  | {
      kind: "user";
      key: string;
      messageId: string;
      inputId: string;
      text: string;
      uploads?: UserUpload[];
      firstSequence: number;
      lastSequence: number;
    }
  | {
      kind: "text";
      messageId?: string;
      key: string;
      text: string;
      phase?: AssistantMessagePhase;
      firstSequence: number;
      lastSequence: number;
      /** Text recovered before this browser attached; render it without replay animation. */
      recoveredTextLength?: number;
    }
  | {
      kind: "hosted_search";
      key: string;
      activityId: string;
      status: "running" | "completed" | "failed";
      action?: import("@pi-cloud/protocol").ProviderHostedWebSearchAction;
      firstSequence: number;
      lastSequence?: number;
    }
  | {
      kind: "tool_preparing";
      key: string;
      toolCallId: string;
      toolName: string;
      firstSequence: number;
      startedAt: string;
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
    }
);

export type TurnView = {
  scheduledOrigin?: import("@pi-cloud/protocol").ScheduledOrigin;
  continuesBefore?: true;
  continuesAfter?: true;
  historyCursor?: string;
  operation?: ConversationDetailResource["turns"][number]["operation"];
  runId: string | null;
  turnId: string;
  mailboxPosition: number | null;
  /** null until this Turn's accepted input metadata arrives; an empty string is an image-only input. */
  prompt: string | null;
  uploads?: UserUpload[];
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
  inheritedContextSummary?: ConversationDetailResource["inheritedContextSummary"];
  inheritedMessagesTruncated?: ConversationDetailResource["inheritedMessagesTruncated"];
  turns: readonly TurnView[];
  history: ConversationHistoryBoundary;
  historyAnchor?: ConversationHistoryQuery;
  connection: ConnectionView;
  apiError: string | null;
};

export type SessionViewAction =
  | { type: "queue.updated"; queue: InputQueueResource }
  | { type: "session.created"; project: ProjectResource; session: SessionResource }
  | {
      type: "conversation.loaded";
      conversation: ConversationDetailResource;
      preserveInputRevision?: boolean;
    }
  | {
      type: "turn.discovered";
      sessionId: string;
      turn: ConversationDetailResource["turns"][number];
    }
  | {
      type: "turn.accepted";
      accepted: AcceptedTurnResource;
      prompt: string;
      uploads?: UserUpload[];
    }
  | { type: "compact.accepted"; compact: import("@pi-cloud/protocol").ConversationCompactResource }
  | { type: "turn.cancellation.requested"; turnId: string }
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
    history: emptyConversationHistory(),
    connection: { phase: "offline", attempt: 0, message: null },
    apiError: null,
  };
}

function unknownTurn(turnId: string): TurnView {
  return {
    runId: null,
    turnId,
    mailboxPosition: null,
    prompt: null,
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

function appendText(
  turn: TurnView,
  text: string,
  sequence: number,
  phase?: AssistantMessagePhase,
  messageId?: string,
  replace = false,
  settledMessageId?: string,
): TurnView {
  const items = [...turn.items];
  if (messageId !== undefined) {
    const index = items.findIndex((item) => item.kind === "text" && item.messageId === messageId);
    const old = items[index];
    if (old?.kind === "text") {
      items[index] = {
        ...old,
        text: replace ? text : old.text + text,
        ...(settledMessageId === undefined ? {} : { messageId: settledMessageId }),
        lastSequence: sequence,
        ...(phase === undefined ? {} : { phase }),
      };
      return { ...turn, status: "running", items };
    }
  }
  const last = items.at(-1);
  if (
    last?.kind === "text" &&
    messageId === undefined &&
    last.messageId === undefined &&
    last.phase !== "commentary" &&
    phase !== "commentary" &&
    last.phase === phase
  ) {
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
      ...(messageId === undefined ? {} : { messageId: settledMessageId ?? messageId }),
      ...(phase === undefined ? {} : { phase }),
      firstSequence: sequence,
      lastSequence: sequence,
    });
  }
  return { ...turn, status: "running", items };
}

function transcriptItem(
  item: NonNullable<ConversationDetailResource["turns"][number]["transcript"]>["items"][number],
): TranscriptItem {
  if (item.kind === "user") return { ...item, key: `user:${item.inputId}` };
  if (item.kind === "tool_preparing") return { ...item, key: `tool-preparing:${item.toolCallId}` };
  if (item.kind === "text") {
    return {
      ...item,
      key: `text:${item.messageId ?? item.historyCursor ?? String(item.firstSequence)}`,
    };
  }
  if (item.kind === "hosted_search") {
    return { ...item, key: `hosted-search:${item.activityId}` };
  }
  if (item.kind === "tool") {
    return { ...item, key: `tool:${item.toolCallId}` };
  }
  if (item.kind === "notification") {
    return { ...item, key: `notification:${item.historyCursor ?? String(item.sequence)}` };
  }
  if (item.kind === "compaction") {
    return { ...item, key: `compaction:${item.historyCursor ?? String(item.firstSequence)}` };
  }
  return { ...item, key: `retry:${item.historyCursor ?? String(item.sequence)}` };
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
        ...(event.payload.scheduledOrigin
          ? { scheduledOrigin: event.payload.scheduledOrigin }
          : {}),
        ...(event.payload.inputKind === "compact"
          ? { operation: { kind: "compact" as const, state: "summarizing" as const }, prompt: "" }
          : {}),
        failure: null,
        cancellation: null,
      };
    }
    if (event.type === "user.input") {
      if (turn.items.some((item) => item.kind === "user" && item.inputId === event.payload.inputId))
        return turn;
      return {
        ...turn,
        status: "running",
        items: [
          ...turn.items,
          {
            kind: "user",
            key: `user:${event.payload.inputId}`,
            ...event.payload,
            firstSequence: event.seq,
            lastSequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "assistant.text.delta") {
      return appendText(
        turn,
        event.payload.text,
        event.seq,
        event.payload.phase,
        event.payload.messageId,
        event.payload.replace,
        event.payload.settledMessageId,
      );
    }
    if (event.type === "provider.hosted_tool.started") {
      if (
        turn.items.some(
          (item) => item.kind === "hosted_search" && item.activityId === event.payload.activityId,
        )
      ) {
        return { ...turn, status: "running" };
      }
      return {
        ...turn,
        status: "running",
        items: [
          ...turn.items,
          {
            kind: "hosted_search",
            key: `hosted-search:${event.payload.activityId}`,
            activityId: event.payload.activityId,
            status: "running",
            firstSequence: event.seq,
          },
        ],
      };
    }
    if (event.type === "provider.hosted_tool.completed") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (item.kind !== "hosted_search" || item.activityId !== event.payload.activityId) {
          return item;
        }
        matched = true;
        return {
          ...item,
          status: event.payload.outcome,
          ...(event.payload.action === undefined ? {} : { action: event.payload.action }),
          lastSequence: event.seq,
        };
      });
      return {
        ...turn,
        items: matched
          ? items
          : [
              ...items,
              {
                kind: "hosted_search",
                key: `hosted-search:${event.payload.activityId}`,
                activityId: event.payload.activityId,
                status: event.payload.outcome,
                ...(event.payload.action === undefined ? {} : { action: event.payload.action }),
                firstSequence: event.seq,
                lastSequence: event.seq,
              },
            ],
      };
    }
    if (event.type === "assistant.tool_call.preparing") {
      if (
        turn.items.some(
          (item) =>
            (item.kind === "tool_preparing" || item.kind === "tool") &&
            item.toolCallId === event.payload.toolCallId,
        )
      ) {
        return { ...turn, status: "running" };
      }
      return {
        ...turn,
        status: "running",
        items: [
          ...turn.items,
          {
            kind: "tool_preparing",
            key: `tool:${event.payload.toolCallId}`,
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            firstSequence: event.seq,
            startedAt: event.occurredAt,
          },
        ],
      };
    }
    if (event.type === "tool.started") {
      let matched = false;
      const items = turn.items.map((item): TranscriptItem => {
        if (
          (item.kind !== "tool" && item.kind !== "tool_preparing") ||
          item.toolCallId !== event.payload.toolCallId
        ) {
          return item;
        }
        matched = true;
        return {
          kind: "tool",
          key: item.key,
          toolCallId: item.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          firstSequence: item.firstSequence,
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
        if (
          (item.kind !== "tool" && item.kind !== "tool_preparing") ||
          item.toolCallId !== event.payload.toolCallId
        )
          return item;
        matched = true;
        return {
          ...item,
          kind: "tool",
          // Pi can reject arguments before any tool.started/intent boundary.
          // Replace preparation with the error instead of leaving a duplicate spinner.
          input: item.kind === "tool" ? item.input : null,
          startedAt: item.kind === "tool" ? item.startedAt : event.occurredAt,
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
          ...turn.items.filter((item) => item.kind !== "tool_preparing"),
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
    if (
      event.type === "model.sampling.completed" &&
      (event.payload.outcome === "failed" || event.payload.outcome === "aborted")
    ) {
      return {
        ...turn,
        items: turn.items
          .filter((item) => item.kind !== "tool_preparing")
          .map((item) =>
            item.kind === "hosted_search" && item.status === "running"
              ? { ...item, status: "failed" as const, lastSequence: event.seq }
              : item,
          ),
      };
    }
    if (event.type === "turn.completed") {
      return {
        ...turn,
        items: turn.items
          .filter((item) => item.kind !== "tool_preparing")
          .map((item) =>
            item.kind === "hosted_search" && item.status === "running"
              ? { ...item, status: "completed" as const, lastSequence: event.seq }
              : item,
          ),
        status: "completed",
        terminalSequence: event.seq,
        stopReason: event.payload.stopReason,
        ...(turn.operation
          ? {
              operation: {
                ...turn.operation,
                state:
                  event.payload.stopReason === "compact_no_op"
                    ? ("no_op" as const)
                    : event.payload.stopReason === "compact_stale"
                      ? ("stale" as const)
                      : ("applied" as const),
              },
            }
          : {}),
      };
    }
    if (event.type === "turn.failed") {
      return {
        ...turn,
        items: turn.items
          .filter((item) => item.kind !== "tool_preparing")
          .map((item): TranscriptItem => {
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
            if (item.kind === "hosted_search" && item.status === "running") {
              return { ...item, status: "failed", lastSequence: event.seq };
            }
            return item;
          }),
        ...(turn.operation ? { operation: { ...turn.operation, state: "failed" as const } } : {}),
        status: "failed",
        terminalSequence: event.seq,
        failure: event.payload,
      };
    }
    if (event.type === "turn.cancelled") {
      return {
        ...turn,
        items: turn.items
          .filter((item) => item.kind !== "tool_preparing")
          .map((item): TranscriptItem => {
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
            if (item.kind === "hosted_search" && item.status === "running") {
              return { ...item, status: "failed", lastSequence: event.seq };
            }
            return item;
          }),
        ...(turn.operation
          ? { operation: { ...turn.operation, state: "cancelled" as const } }
          : {}),
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

function reduceSessionView(state: SessionViewState, action: SessionViewAction): SessionViewState {
  if (action.type === "turn.discovered") {
    if (state.session?.sessionId !== action.sessionId) return state;
    return {
      ...state,
      turns: updateTurn(state.turns, action.turn.turnId, (current) => ({
        ...current,
        prompt: action.turn.prompt,
        ...(action.turn.scheduledOrigin ? { scheduledOrigin: action.turn.scheduledOrigin } : {}),
        ...(action.turn.operation ? { operation: action.turn.operation } : {}),
        ...(action.turn.uploads ? { uploads: action.turn.uploads } : {}),
        runId: action.turn.runId,
        mailboxPosition: action.turn.mailboxPosition,
        acceptedAt: action.turn.acceptedAt,
      })),
    };
  }
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
      inheritedContextSummary: action.conversation.inheritedContextSummary,
      inheritedMessagesTruncated: action.conversation.inheritedMessagesTruncated,
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
              items: turn.transcript.items.map((item) => ({
                ...transcriptItem(item),
                pageKey:
                  action.conversation.history.before ?? action.conversation.session.sessionId,
              })),
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
        ...(turn.scheduledOrigin ? { scheduledOrigin: turn.scheduledOrigin } : {}),
        ...(turn.operation ? { operation: turn.operation } : {}),
        ...(turn.continuesBefore ? { continuesBefore: true as const } : {}),
        ...(turn.continuesAfter ? { continuesAfter: true as const } : {}),
        ...(turn.historyCursor ? { historyCursor: turn.historyCursor } : {}),
        ...(turn.uploads ? { uploads: turn.uploads } : {}),
        acceptedAt: turn.acceptedAt,
        status: turn.state,
      })),
      history: action.conversation.history,
      connection: { phase: "offline", attempt: 0, message: "Opening durable event stream" },
    };
    return {
      ...loaded,
      turns: [
        ...loaded.turns.map((turn) => ({
          ...turn,
          items: turn.items.map((item) =>
            item.kind === "text" ? { ...item, recoveredTextLength: item.text.length } : item,
          ),
        })),
      ],
    };
  }
  if (action.type === "turn.accepted") {
    const turns = updateTurn(state.turns, action.accepted.turnId, (turn) => ({
      ...turn,
      runId: action.accepted.runId,
      mailboxPosition: action.accepted.mailboxPosition,
      prompt: action.prompt,
      ...(action.uploads ? { uploads: action.uploads } : {}),
      acceptedAt: action.accepted.acceptedAt,
      status:
        turn.startedSequence === null && !["completed", "failed", "cancelled"].includes(turn.status)
          ? "queued"
          : turn.status,
    }));
    return { ...state, turns, apiError: null };
  }
  if (action.type === "queue.updated") {
    if (state.session?.sessionId !== action.queue.sessionId) return state;
    const history = state.turns.filter(
      (turn) => turn.status !== "queued" || turn.operation !== undefined,
    );
    const started = new Set(history.map((turn) => turn.turnId));
    const pending = action.queue.items
      .filter((item) => !item.inputId.startsWith("input-") && !started.has(item.inputId))
      .map((item) => ({
        ...unknownTurn(item.inputId),
        runId: item.runId,
        mailboxPosition: item.mailboxPosition,
        prompt: item.text,
        ...(item.uploads ? { uploads: item.uploads } : {}),
        acceptedAt: item.acceptedAt,
        status: "queued" as const,
      }));
    const previous = state.turns.filter(
      (turn) => turn.status === "queued" && turn.operation === undefined,
    );
    if (
      previous.length === pending.length &&
      previous.every((turn, index) => {
        const next = pending[index]!;
        return (
          turn.turnId === next.turnId &&
          turn.prompt === next.prompt &&
          JSON.stringify(turn.uploads ?? []) === JSON.stringify(next.uploads ?? []) &&
          turn.mailboxPosition === next.mailboxPosition &&
          turn.runId === next.runId
        );
      })
    )
      return state;
    return { ...state, turns: [...history, ...pending] };
  }
  if (action.type === "compact.accepted") {
    const value = action.compact;
    if (!value.initialOperation || state.session?.sessionId !== value.sessionId) return state;
    return {
      ...state,
      turns: updateTurn(state.turns, value.turnId, (turn) => ({
        ...turn,
        runId: value.runId,
        prompt: "",
        acceptedAt: value.acceptedAt,
        operation: { kind: "compact", state: value.state },
        status:
          value.state === "queued"
            ? "queued"
            : value.state === "cancelled"
              ? "cancelled"
              : value.state === "failed"
                ? "failed"
                : ["applied", "no_op", "stale"].includes(value.state)
                  ? "completed"
                  : "running",
      })),
      apiError: null,
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

/** A historical page is already bounded by the API and must not be truncated a
 * second time. It cannot advance the separately maintained live view. */
export function conversationPageView(conversation: ConversationDetailResource): SessionViewState {
  return reduceSessionView(createInitialSessionView(), {
    type: "conversation.loaded",
    conversation,
  });
}
const itemSizes = new WeakMap<object, number>();
export function presentationItemCharacters(item: TranscriptItem): number {
  const cached = itemSizes.get(item);
  if (cached !== undefined) return cached;
  const size =
    item.kind === "text" || item.kind === "user"
      ? item.text.length + 256
      : JSON.stringify(item).length;
  itemSizes.set(item, size);
  return size;
}
export function itemHistoryQuery(
  turn: TurnView,
  item: TranscriptItem,
): ConversationHistoryQuery | undefined {
  if (item.historyCursor) return { at: item.historyCursor };
  if ((item.kind === "text" || item.kind === "user") && item.messageId) {
    const id = /^entry:([1-9][0-9]*)(?::|$)/.exec(item.messageId)?.[1];
    if (id) return { turnId: turn.turnId, entryId: id };
  }
  if (item.kind === "tool") {
    const id = /^entry:([1-9][0-9]*)$/.exec(item.toolCallId)?.[1];
    if (id) return { turnId: turn.turnId, entryId: id };
    if (/^task:[1-9][0-9]*$/.test(item.toolCallId))
      return { turnId: turn.turnId, toolCallId: item.toolCallId };
  }
  return undefined;
}
export function retainLiveWindow(state: SessionViewState): SessionViewState {
  let count = 0,
    characters = 0,
    removed = false;
  const turns: TurnView[] = [];
  let lastRemoved: ConversationHistoryQuery | undefined;
  for (let t = state.turns.length - 1; t >= 0; t--) {
    const turn = state.turns[t]!;
    const items: TranscriptItem[] = [];
    let clipped = false;
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const item = turn.items[i]!,
        size = presentationItemCharacters(item);
      const pending = item.kind === "tool" && item.status === "running";
      if (
        pending ||
        count === 0 ||
        (count < HISTORY_LIVE_ITEMS && characters + size <= HISTORY_LIVE_CHARACTERS)
      ) {
        items.unshift(item);
        count++;
        characters += size;
      } else {
        clipped = true;
        removed = true;
        lastRemoved ??= itemHistoryQuery(turn, item);
      }
    }
    if (!items.length && t !== state.turns.length - 1 && count >= HISTORY_LIVE_ITEMS) {
      removed = true;
      continue;
    }
    const header = turn.prompt?.length ?? 0;
    const includeHeader = !clipped && characters + header <= HISTORY_LIVE_CHARACTERS;
    if (!includeHeader && header) removed = true;
    if (includeHeader) characters += header;
    if (!items.length && t !== state.turns.length - 1 && characters >= HISTORY_LIVE_CHARACTERS) {
      removed = true;
      continue;
    }
    const { uploads: _uploads, ...withoutUploads } = turn;
    turns.unshift(
      clipped || !includeHeader
        ? { ...withoutUploads, prompt: null, continuesBefore: true, items }
        : turn,
    );
    count++;
    characters += 256;
  }
  if (!removed) return state;
  const oldest = turns[0];
  const firstQuery = oldest?.items.map((item) => itemHistoryQuery(oldest, item)).find(Boolean);
  return {
    ...state,
    turns,
    history: { ...state.history, hasBefore: true },
    ...((firstQuery ??
    lastRemoved ??
    state.historyAnchor ??
    (oldest ? { turnId: oldest.turnId } : undefined))
      ? {
          historyAnchor: firstQuery ??
            lastRemoved ??
            state.historyAnchor ?? { turnId: oldest!.turnId },
        }
      : {}),
  };
}
export function sessionViewReducer(
  state: SessionViewState,
  action: SessionViewAction,
): SessionViewState {
  return retainLiveWindow(reduceSessionView(state, action));
}
