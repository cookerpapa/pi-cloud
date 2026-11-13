import type { InputQueueResource } from "@pi-cloud/protocol";
import type { ComposerPlacement, ComposerSubmissionView } from "@pi-cloud/session-client";
import type { SessionViewState, TurnView } from "@pi-cloud/session-client";

export function composerPlacement(
  state: SessionViewState,
  queue: InputQueueResource | null,
  busy: boolean,
): ComposerPlacement {
  return {
    placement: busy ? "queue" : "timeline",
    afterMailboxPosition: Math.max(0, ...state.turns.map((turn) => turn.mailboxPosition ?? 0)),
    afterSequence: state.turns.reduce(
      (latest, turn) =>
        Math.max(
          latest,
          turn.startedSequence ?? 0,
          turn.terminalSequence ?? 0,
          ...turn.items.map((item) =>
            "lastSequence" in item
              ? (item.lastSequence ?? item.firstSequence)
              : "firstSequence" in item
                ? item.firstSequence
                : item.sequence,
          ),
        ),
      0,
    ),
    knownInputIds: queue?.items.map((item) => item.inputId) ?? [],
  };
}

/** This only suppresses redundant provisional text; it never associates an
 * unconfirmed request with someone else's input or retires its retry identity. */
export function authoritativeInputAppeared(
  view: ComposerSubmissionView,
  turns: readonly TurnView[],
  queue?: InputQueueResource | null,
) {
  return (
    turns.some(
      (turn) =>
        turn.presentationKey === view.key ||
        (turn.prompt !== null && (turn.mailboxPosition ?? 0) > view.afterMailboxPosition) ||
        turn.items.some((item) => item.kind === "user" && item.firstSequence > view.afterSequence),
    ) || Boolean(queue?.items.some((item) => !view.knownInputIds.includes(item.inputId)))
  );
}

export function withLocalSubmission(
  turns: readonly TurnView[],
  view: ComposerSubmissionView | null,
  queue?: InputQueueResource | null,
): readonly TurnView[] {
  if (
    !view ||
    view.input.kind !== "turn" ||
    view.placement !== "timeline" ||
    authoritativeInputAppeared(view, turns, queue)
  )
    return turns;
  const local: TurnView = {
    turnId: `local:${view.key}`,
    runId: null,
    presentationKey: view.key,
    localSubmission: view,
    mailboxPosition: null,
    prompt: view.input.text,
    acceptedAt: null,
    status: "queued",
    items: [],
    startedSequence: null,
    terminalSequence: null,
    stopReason: null,
    failure: null,
    cancellation: null,
  };
  const next = turns.findIndex(
    (turn) =>
      (turn.mailboxPosition ?? 0) > view.afterMailboxPosition ||
      (turn.startedSequence ?? 0) > view.afterSequence,
  );
  const position = next < 0 ? turns.length : next;
  return [...turns.slice(0, position), local, ...turns.slice(position)];
}
