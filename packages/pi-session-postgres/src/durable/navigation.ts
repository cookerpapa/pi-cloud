import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import type { DurableScope } from "./types.ts";

export type NavigationEntry = {
  id: number;
  seq: number;
  kind: string;
  role: "user" | "assistant" | "other";
  text: string;
  finalAssistant: boolean;
  turnId: string | null;
  createdAt: string;
};
/** Bounded, rebuildable captions. Native bodies are not fetched for a sidebar. */
export async function readNavigationEntries(
  db: Kysely<Database>,
  input: DurableScope & {
    conversationId: number;
    limit: number;
    from?: number;
    through?: number;
    includeIds?: readonly number[];
  },
): Promise<{ entries: NavigationEntry[]; hasMore: boolean; beforeId: string | null }> {
  const projection = new DurablePostgresProjection(db, input, undefined, "references");
  let conversation = input.conversationId,
    through = input.through ?? Number.MAX_SAFE_INTEGER;
  const entries: NavigationEntry[] = [],
    forced: NavigationEntry[] = [];
  const visited = new Set<number>();
  const convert = (r: {
    id: string;
    seq: string;
    fields: Record<string, string>;
    committed_at: Date;
  }): NavigationEntry => ({
    id: Number(r.id),
    seq: Number(r.seq),
    kind: JSON.parse(r.fields.nativeKind ?? '"pi.user"'),
    role:
      r.fields.navigation === "assistant"
        ? "assistant"
        : r.fields.navigation === "user"
          ? "user"
          : "other",
    text: r.fields.preview ?? "",
    finalAssistant: r.fields.navigation === "assistant",
    turnId: r.fields.turn ?? null,
    createdAt: r.committed_at.toISOString(),
  });
  while (true) {
    if (visited.has(conversation)) throw new Error("Navigation ancestry cycle");
    visited.add(conversation);
    const native = await projection.get(conversation);
    if (!native) break;
    if (native.kind !== "conversation") throw new Error("Invalid navigation Conversation");
    const remaining = Math.max(0, input.limit + 1 - entries.length);
    if (remaining) {
      const page = await sql<{
        id: string;
        seq: string;
        fields: Record<string, string>;
        committed_at: Date;
      }>`select r.id::text,r.seq::text,r.fields,c.committed_at
        from pi_durable_records r join pi_durable_commits c using(tenant_id,session_id,seq)
        where r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId} and r.kind='entry'
          and r.fields->>'conversation'=${String(conversation)} and r.fields->>'navigation' in ('user','assistant') and r.id<=${through}
          ${input.from === undefined ? sql`` : sql`and r.id>=${input.from}`}
        order by r.id desc limit ${remaining}`.execute(db);
      entries.push(...page.rows.map(convert));
    }
    if (input.includeIds?.length) {
      const needed = await sql<{
        id: string;
        seq: string;
        fields: Record<string, string>;
        committed_at: Date;
      }>`select r.id::text,r.seq::text,r.fields,c.committed_at
        from pi_durable_records r join pi_durable_commits c using(tenant_id,session_id,seq)
        where r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId} and r.kind='entry'
          and r.fields->>'conversation'=${String(conversation)} and r.id=any(${[...input.includeIds]}::bigint[])`.execute(
        db,
      );
      forced.push(...needed.rows.map(convert));
    }
    const parent = (native.value as ConversationRecord).parent;
    if (!parent) break;
    if (
      entries.length > input.limit &&
      !(input.includeIds ?? []).some((id) => !forced.some((r) => r.id === id))
    )
      break;
    conversation = parent.conversationId;
    through = Math.min(through, parent.at);
  }
  const page = entries.slice(0, input.limit);
  const all = new Map([...page, ...forced].map((r) => [r.id, r]));
  return {
    entries: [...all.values()].sort((a, b) => a.id - b.id),
    hasMore: entries.length > input.limit,
    beforeId: page.at(-1) ? String(page.at(-1)!.id) : null,
  };
}
