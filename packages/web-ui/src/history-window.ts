import {
  HISTORY_BROWSER_PAGES,
  type ConversationDetailResource,
  type ConversationHistoryBoundary,
  type ConversationHistoryQuery,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import {
  conversationPageView,
  terminalTurnOutcome,
  itemHistoryQuery,
  type SessionViewState,
  type TurnView,
  type TranscriptItem,
} from "./session-view.ts";

export type HistoryPage = {
  turns: readonly TurnView[];
  history: ConversationHistoryBoundary;
  beforeQuery?: ConversationHistoryQuery;
  afterQuery?: ConversationHistoryQuery;
};
export const historyPage = (value: ConversationDetailResource): HistoryPage => ({
  turns: conversationPageView(value).turns,
  history: value.history,
});
export function freezeHistoryView(value: SessionViewState): HistoryPage {
  const last = value.turns
    .flatMap((turn) => turn.items.map((item) => ({ turn, item })))
    .reverse()
    .map(({ turn, item }) => itemHistoryQuery(turn, item))
    .find(Boolean);
  const afterQuery = last?.at
    ? { after: last.at }
    : last?.turnId && (last.entryId || last.toolCallId)
      ? { ...last, direction: "after" as const }
      : undefined;
  return {
    turns: value.turns.map((turn) =>
      ["queued", "running", "cancelling"].includes(turn.status)
        ? {
            ...turn,
            items: turn.items.map((item) =>
              item.kind === "text" && !item.messageId?.startsWith("entry:")
                ? { ...item, frozenStreaming: true as const }
                : item,
            ),
          }
        : turn,
    ),
    history: { ...value.history, hasAfter: true },
    ...(value.historyAnchor ? { beforeQuery: value.historyAnchor } : {}),
    ...(afterQuery ? { afterQuery } : {}),
  };
}
const sequence = (item: TranscriptItem) =>
  "lastSequence" in item
    ? (item.lastSequence ?? item.firstSequence)
    : "sequence" in item
      ? item.sequence
      : item.firstSequence;
const itemIdentity = (item: TranscriptItem) =>
  item.kind === "text" ? `text:${item.messageId ?? item.key}` : item.key;
export function mergeHistoryPages(pages: readonly HistoryPage[]): readonly TurnView[] {
  const turns = new Map<string, TurnView>();
  for (const page of pages)
    for (const turn of page.turns) {
      const old = turns.get(turn.turnId);
      if (!old) {
        turns.set(turn.turnId, turn);
        continue;
      }
      const items = new Map(old.items.map((item) => [itemIdentity(item), item]));
      for (const item of turn.items) {
        const prior = items.get(itemIdentity(item));
        const seq = sequence(item),
          oldSeq = prior ? sequence(prior) : -1;
        if (!prior || seq >= oldSeq)
          items.set(
            itemIdentity(item),
            prior
              ? { ...item, key: prior.key, ...(prior.pageKey ? { pageKey: prior.pageKey } : {}) }
              : item,
          );
      }
      const { continuesBefore: _before, continuesAfter: _after, ...rest } = turn;
      turns.set(turn.turnId, {
        ...rest,
        items: [...items.values()],
        prompt: old.continuesBefore ? turn.prompt : old.prompt,
        ...(old.uploads ? { uploads: old.uploads } : {}),
        ...(old.continuesBefore && turn.continuesBefore ? { continuesBefore: true as const } : {}),
        ...(turn.continuesAfter ? { continuesAfter: true as const } : {}),
      });
    }
  return [...turns.values()];
}
export function appendHistoryPage(
  pages: readonly HistoryPage[],
  page: HistoryPage,
  direction: "before" | "after",
): readonly HistoryPage[] {
  const same = (a: HistoryPage, b: HistoryPage) =>
    a.history.before === b.history.before && a.history.after === b.history.after;
  const previous = pages.filter((p) => !same(p, page));
  const result = direction === "before" ? [page, ...previous] : [...previous, page];
  if (result.length <= HISTORY_BROWSER_PAGES) return result;
  return direction === "before"
    ? result.slice(0, HISTORY_BROWSER_PAGES)
    : result.slice(-HISTORY_BROWSER_PAGES);
}
export function historyBeforeQuery(page: HistoryPage): ConversationHistoryQuery | undefined {
  if (page.beforeQuery) return page.beforeQuery;
  if (page.history.before) return { before: page.history.before };
  const first = page.turns[0];
  return (
    first?.items.map((item) => itemHistoryQuery(first, item)).find(Boolean) ??
    (first ? { turnId: first.turnId } : undefined)
  );
}

/** A reading window keeps its membership/text stable across live-window trims,
 * while already visible Tools can still finish. No new rows are imported. */
export function refreshReadingState(
  pages: readonly HistoryPage[],
  live: readonly TurnView[],
  updateTools = true,
): readonly HistoryPage[] {
  const currentTurns = new Map(live.map((turn) => [turn.turnId, turn]));
  const known = new Map(
    live.map((turn) => [
      turn.turnId,
      new Map(
        turn.items.flatMap((item) =>
          item.kind === "tool" ? [[item.toolCallId, item] as const] : [],
        ),
      ),
    ]),
  );
  let changed = false;
  const next = pages.map((page) => {
    let pageChanged = false;
    const turns = page.turns.map((turn) => {
      const tools = known.get(turn.turnId);
      if (!tools) return turn;
      const currentTurn = currentTurns.get(turn.turnId)!;
      const terminal =
        ["completed", "failed", "cancelled"].includes(currentTurn.status) &&
        (!["completed", "failed", "cancelled"].includes(turn.status) ||
          (currentTurn.terminalSequence ?? -1) > (turn.terminalSequence ?? -1));
      let turnChanged = terminal;
      const items = !updateTools
        ? turn.items
        : turn.items.map((item) => {
            if (item.kind !== "tool" && item.kind !== "tool_preparing") return item;
            const current = tools.get(item.toolCallId);
            if (
              !current ||
              sequence(current) <= sequence(item) ||
              (item.kind === "tool" && item.status !== "running" && current.status === "running")
            )
              return item;
            turnChanged = true;
            return {
              ...current,
              key: item.key,
              firstSequence: item.firstSequence,
              toolName: item.toolName === "unknown" ? current.toolName : item.toolName,
              input: item.kind === "tool" ? (item.input ?? current.input) : current.input,
              ...(item.pageKey ? { pageKey: item.pageKey } : {}),
              ...(item.historyCursor ? { historyCursor: item.historyCursor } : {}),
            };
          });
      if (!turnChanged) return turn;
      pageChanged = true;
      return {
        ...turn,
        ...(terminal
          ? {
              status: currentTurn.status,
              terminalSequence: currentTurn.terminalSequence,
              stopReason: currentTurn.stopReason,
              failure: currentTurn.failure,
              cancellation: currentTurn.cancellation,
              ...(currentTurn.operation ? { operation: currentTurn.operation } : {}),
            }
          : {}),
        items,
      };
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, turns };
  });
  return changed ? next : pages;
}
/** A frozen reading position does not append live output. Settled identities are
 * still renamed so a later canonical page replaces the same item, without duplicates. */
export function observeHistoryPages(
  pages: readonly HistoryPage[],
  event: PiCloudEvent,
): readonly HistoryPage[] {
  const outcome = terminalTurnOutcome(event);
  if (outcome)
    return pages.map((page) => ({
      ...page,
      turns: page.turns.map((turn) =>
        turn.turnId === event.turnId && (turn.terminalSequence ?? -1) < event.seq
          ? { ...turn, ...terminalTurnOutcome(event, turn.operation) }
          : turn,
      ),
    }));
  if (event.type !== "assistant.text.delta" || !event.payload.settledMessageId) return pages;
  return pages.map((p) => ({
    ...p,
    turns: p.turns.map((t) =>
      t.turnId !== event.turnId
        ? t
        : {
            ...t,
            items: t.items.map((item) =>
              item.kind === "text" && item.messageId === event.payload.messageId
                ? { ...item, messageId: event.payload.settledMessageId! }
                : item,
            ),
          },
    ),
  }));
}
