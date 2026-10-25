import { sql, type Kysely } from "kysely";

/** Rebuildable positions only. Native bodies and their fingerprints stay intact. */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`lock table runs,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before history index cutover'; end if;
    end $$;
    create index pi_durable_history_position on pi_durable_log(tenant_id,(cloud_origin->>'turn'),seq,ordinal)
      where record_kind='entry' or (record_kind='task' and phase='"retry"');
    create index pi_durable_task_history_position on pi_durable_records(tenant_id,(fields->>'turn'),seq,ordinal) where kind='task' and fields->>'nativeKind' in ('"pi.tool"','"pi.compaction"') and not(fields ? 'resultEntry');
    create index pi_durable_entry_task on pi_durable_records(tenant_id,session_id,(fields->>'task'),id) where kind='entry';
    create index pi_durable_entry_role on pi_durable_records(tenant_id,session_id,(fields->>'conversation'),(fields->>'role'),id) where kind='entry';
    create index pi_durable_submission_entry on pi_durable_records(tenant_id,session_id,(fields->>'entry'),id) where kind='submission';
  `.execute(db);
  let cursor: { tenant: string; session: string; id: string } | undefined;
  for (;;) {
    const rows: { rows: { tenant_id: string; session_id: string; id: string; body: string }[] } =
      await sql<{
        tenant_id: string;
        session_id: string;
        id: string;
        body: string;
      }>`select r.tenant_id::text,r.session_id,r.id::text,l.body
      from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.kind='task' and r.fields->>'nativeKind' in ('"pi.tool"','"pi.compaction"')
        ${cursor ? sql`and (r.tenant_id,r.session_id,r.id)>(${cursor.tenant}::uuid,${cursor.session},${cursor.id}::bigint)` : sql``}
      order by r.tenant_id,r.session_id,r.id limit 32`.execute(db);
    if (!rows.rows.length) break;
    const values = rows.rows.map((row) => {
      const task = JSON.parse(row.body).value;
      const fields: Record<string, string> = {};
      if (task.kind === "pi.tool") {
        if (!Number.isSafeInteger(task.input?.assistant) || task.input.assistant < 1)
          throw new Error("Invalid native Tool assistant identity");
        fields.assistant = String(task.input.assistant);
      }
      const result = task.state?.outcome?.result;
      if (typeof result?.entryId === "number") fields.resultEntry = String(result.entryId);
      if (typeof result?.submissionId === "number")
        fields.resultSubmission = String(result.submissionId);
      return { ...row, fields };
    });
    await sql`update pi_durable_records r set fields=r.fields||p.fields
      from unnest(${values.map((r) => r.tenant_id)}::uuid[],${values.map((r) => r.session_id)}::text[],${values.map((r) => r.id)}::bigint[],${values.map((r) => JSON.stringify(r.fields))}::jsonb[]) p(tenant_id,session_id,id,fields)
      where r.tenant_id=p.tenant_id and r.session_id=p.session_id and r.id=p.id`.execute(db);
    const last = rows.rows.at(-1)!;
    cursor = { tenant: last.tenant_id, session: last.session_id, id: last.id };
  }
  cursor = undefined;
  for (;;) {
    const rows: { rows: { tenant_id: string; session_id: string; id: string; body: string }[] } =
      await sql<{
        tenant_id: string;
        session_id: string;
        id: string;
        body: string;
      }>`select r.tenant_id::text,r.session_id,r.id::text,l.body
      from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.kind='entry' and r.fields->>'navigation' in ('user','assistant')
        ${cursor ? sql`and (r.tenant_id,r.session_id,r.id)>(${cursor.tenant}::uuid,${cursor.session},${cursor.id}::bigint)` : sql``}
      order by r.tenant_id,r.session_id,r.id limit 32`.execute(db);
    if (!rows.rows.length) break;
    const values = rows.rows.map((row) => {
      const entry = JSON.parse(row.body).value;
      if (entry.kind === "pi.compaction") return { ...row, fields: { navigation: "none" } };
      const message = entry.model?.find(
        (m: { role?: string }) => m.role === "user" || m.role === "assistant",
      );
      const text =
        typeof message?.content === "string"
          ? message.content
          : (message?.content ?? [])
              .filter((p: { type: string }) => p.type === "text")
              .map((p: { text: string }) => p.text)
              .join("\n");
      return {
        ...row,
        fields: { preview: text.slice(0, 256).replace(/[\u0000\uD800-\uDFFF]/gu, "\uFFFD") },
      };
    });
    await sql`update pi_durable_records r set fields=r.fields||p.fields
      from unnest(${values.map((r) => r.tenant_id)}::uuid[],${values.map((r) => r.session_id)}::text[],${values.map((r) => r.id)}::bigint[],${values.map((r) => JSON.stringify(r.fields))}::jsonb[]) p(tenant_id,session_id,id,fields)
      where r.tenant_id=p.tenant_id and r.session_id=p.session_id and r.id=p.id`.execute(db);
    const last = rows.rows.at(-1)!;
    cursor = { tenant: last.tenant_id, session: last.session_id, id: last.id };
  }
}
export async function down(): Promise<void> {
  throw new Error("History presentation requires a matched forward upgrade");
}
