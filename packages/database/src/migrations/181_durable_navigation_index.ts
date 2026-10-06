import { sql, type Kysely } from "kysely";

/** Derived metadata only. Never coerce exact native JSON-text bodies to JSONB. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  let cursor: { tenant: string; session: string; id: string } | undefined;
  for (;;) {
    const { rows } = await sql<{ tenant_id: string; session_id: string; id: string; body: string }>`
      select r.tenant_id,r.session_id,r.id,l.body from pi_durable_records r
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.kind in ('entry','document') ${cursor ? sql`and (r.tenant_id,r.session_id,r.id)>(${cursor.tenant}::uuid,${cursor.session},${cursor.id}::bigint)` : sql``}
      order by r.tenant_id,r.session_id,r.id limit 32`.execute(database);
    if (!rows.length) break;
    const updates = rows.map((row) => {
      const write = JSON.parse(row.body),
        entry = write.value;
      if (write.type === "document.create") {
        const currentOnly = String(
          write.record.scope.kind !== "conversation" || write.record.history === "latest",
        );
        return sql`(${row.tenant_id}::uuid,${row.session_id},${row.id}::bigint,${JSON.stringify({ currentOnly })}::jsonb)`;
      }
      const message = entry.model?.find(
        (value: { role?: string }) => value.role === "user" || value.role === "assistant",
      );
      const navigation =
        message?.role === "user"
          ? "user"
          : message?.role === "assistant" &&
              typeof message.stopReason === "string" &&
              !["toolUse", "error", "aborted", "pending", "deferred"].includes(message.stopReason)
            ? "assistant"
            : "none";
      return sql`(${row.tenant_id}::uuid,${row.session_id},${row.id}::bigint,${JSON.stringify({ navigation })}::jsonb)`;
    });
    await sql`update pi_durable_records r set fields=r.fields || v.fields
      from (values ${sql.join(updates)}) as v(tenant_id,session_id,id,fields)
      where r.tenant_id=v.tenant_id and r.session_id=v.session_id and r.id=v.id`.execute(database);
    const last = rows.at(-1)!;
    cursor = { tenant: last.tenant_id, session: last.session_id, id: last.id };
  }
  await sql`alter table pi_durable_records add constraint pi_durable_navigation_required
    check(kind<>'entry' or coalesce(fields->>'navigation' in ('user','assistant','none'),false));
    alter table pi_durable_records add constraint pi_durable_document_policy_required
      check(kind<>'document' or coalesce(fields->>'currentOnly' in ('true','false'),false));
    create index pi_durable_navigation on pi_durable_records(tenant_id,session_id,(fields->>'conversation'),id)
      where kind='entry' and fields->>'navigation' in ('user','assistant');`.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore matched navigation index and projector artifacts");
}
