import type {
  ConversationHistoryQuery,
  ConversationSearchResult,
  ConversationTranscriptItemResource,
} from "@pi-cloud/protocol";
import { ConversationReader } from "./conversation-reader.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

function searchable(item: ConversationTranscriptItemResource): string {
  if (item.kind === "text" || item.kind === "user") return item.text;
  if (item.kind === "tool")
    return [item.toolName, JSON.stringify(item.input), JSON.stringify(item.output)]
      .filter(Boolean)
      .join("\n");
  if (item.kind === "notification") return item.message;
  if (item.kind === "hosted_search") return JSON.stringify(item.action ?? {});
  return "";
}
/** One cancellable page per request; the client advances the returned read
 * cursor until it has enough hits. No all-history body or second search store. */
export async function searchConversationPage(
  reader: ConversationReader,
  sessionId: string,
  text: string,
  before?: string,
): Promise<ConversationSearchResult> {
  const needle = text.trim().toLowerCase();
  if (!needle || needle.length > 256)
    throw new ControlPlaneStoreError("invalid_request", "Search must contain 1–256 characters");
  const query: ConversationHistoryQuery = before ? { before } : {};
  const page = await reader.getConversation(sessionId, query);
  const results: ConversationSearchResult["results"] = [];
  const found = new Set<string>();
  const add = (turnId: string, cursor: string | undefined, kind: string, body: string) => {
    if (!cursor || found.has(cursor)) return;
    const at = body.toLowerCase().indexOf(needle);
    if (at < 0) return;
    found.add(cursor);
    results.push({ turnId, cursor, kind, snippet: body.slice(Math.max(0, at - 100), at + 200) });
  };
  for (const turn of [...page.turns].reverse()) {
    for (const item of [...(turn.transcript?.items ?? [])].reverse())
      add(turn.turnId, item.historyCursor, item.kind, searchable(item));
    if (!turn.continuesBefore)
      add(
        turn.turnId,
        turn.historyCursor,
        "user",
        turn.prompt || turn.operation?.instructions || "",
      );
  }
  return { sessionId, results, nextCursor: page.history.hasBefore ? page.history.before : null };
}
