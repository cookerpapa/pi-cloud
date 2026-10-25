import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { ConversationTurnTranscriptResource } from "@pi-cloud/protocol";
import { readCanonicalHistoryWindow } from "./canonical-history-window.ts";
export {
  projectDurableTranscript,
  terminalMetadata,
  type NativeHistoryRow,
} from "./native-transcript-presentation.ts";

/** Bounded canonical presentation for callers which already own a Turn set.
 * Browser pagination uses the same window reader directly, including cursors. */
export async function readCanonicalPiTurnTranscripts(
  database: Kysely<Database>,
  input: { tenantId: string; turnIds: readonly string[]; imageSessionId?: string },
): Promise<ReadonlyMap<string, ConversationTurnTranscriptResource>> {
  if (!input.turnIds.length) return new Map();
  if (input.turnIds.length > 40) throw new Error("Read canonical Turns in bounded pages");
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readCanonicalPiTurnTranscripts(tx, input));
  const sources = await database
    .selectFrom("conversation_turns as t")
    .innerJoin("sessions as s", (join) =>
      join.onRef("s.tenant_id", "=", "t.tenant_id").onRef("s.id", "=", "t.session_id"),
    )
    .select([
      "t.turn_id as turnId",
      "t.session_id as originSessionId",
      "s.pi_session_id as piSessionId",
      "t.operation_kind as operationKind",
    ])
    .where("t.tenant_id", "=", input.tenantId)
    .where("t.turn_id", "in", [...input.turnIds])
    .where("t.pruned_at", "is", null)
    .orderBy("t.created_at", "desc")
    .execute();
  if (!sources.length) return new Map();
  return (
    await readCanonicalHistoryWindow(database, {
      tenantId: input.tenantId,
      sessionId: input.imageSessionId ?? sources[0]!.originSessionId,
      turns: sources,
      direction: "before",
    })
  ).transcripts;
}

/** Child prompts remain in the original native intent. Decode opaque JSON in JS,
 * where escaped NUL and unpaired surrogates are legal, never by PG jsonb casts. */
export function conversationPrompt(text: string | null, source: string | null): string | null {
  if (source === null) return text;
  const write = JSON.parse(source);
  const args =
    write.type === "task"
      ? write.value?.state?.checkpoint?.arguments
      : write.content?.value?.arguments;
  if (typeof args?.task !== "string") throw new Error("Native child prompt source is invalid");
  return args.task;
}
