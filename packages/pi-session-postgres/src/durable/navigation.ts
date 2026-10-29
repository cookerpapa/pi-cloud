import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
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
  const path = await projection.conversationPath(
    input.conversationId,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  if (!path.length) return { entries: [], hasMore: false, beforeId: null };
  const scopes = sql`(values ${sql.join(path.map((r, i) => sql`(${r.record.value.id}::bigint,${r.through}::bigint,${i}::int)`))})`;
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
  type Row = { id: string; seq: string; fields: Record<string, string>; committed_at: Date };
  const entries = (
    await sql<Row>`select r.id::text,r.seq::text,r.fields,g.committed_at
    from ${scopes} s(conversation_id,through_id,position) join pi_durable_records r
      on r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId} and r.kind='entry'
        and r.fields->>'conversation'=s.conversation_id::text and r.id<=least(s.through_id,${input.through ?? Number.MAX_SAFE_INTEGER})
        and r.id>=${input.from ?? 0} and r.fields->>'navigation' in ('user','assistant')
    join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
    order by s.position,r.id desc limit ${input.limit + 1}`.execute(db)
  ).rows.map(convert);
  const forced = input.includeIds?.length
    ? (
        await sql<Row>`select r.id::text,r.seq::text,r.fields,g.committed_at
    from ${scopes} s(conversation_id,through_id,position) join pi_durable_records r
      on r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId} and r.kind='entry'
        and r.fields->>'conversation'=s.conversation_id::text and r.id<=s.through_id and r.id=any(${[...input.includeIds]}::bigint[])
    join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id`.execute(db)
      ).rows.map(convert)
    : [];
  const page = entries.slice(0, input.limit);
  const all = new Map([...page, ...forced].map((r) => [r.id, r]));
  return {
    entries: [...all.values()].sort((a, b) => a.id - b.id),
    hasMore: entries.length > input.limit,
    beforeId: page.at(-1) ? String(page.at(-1)!.id) : null,
  };
}
