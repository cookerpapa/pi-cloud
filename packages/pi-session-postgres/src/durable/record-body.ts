import { sql } from "kysely";

/** Bound the UNION lookup to one indexed position before resolving its shared body.
 * A flat join can choose a whole-history hash join, even for a single native ID. */
export const nativeBodyAtRecord = sql`left join lateral (
  select case when g.record_kind='entry' then
      concat(pi_native_entry_prefix(g.record_id,g.entry_conversation_id,case when r.body_fork then null::bigint else g.entry_task_id end),substr(b.payload_text,2),'}')
    when r.body_fork and g.record_kind='conversation' then jsonb_set(g.body::jsonb,'{value}',(g.body::jsonb->'value')-'owner')::text
    else g.body end as body,g.committed_at
  from pi_history_records g left join pi_history_bodies b on b.tenant_id=g.tenant_id and b.id=g.entry_body_id
  where g.tenant_id=r.tenant_id and g.id=r.retained_record_id
  union all
  select c.body,c.committed_at from pi_durable_current c
  where r.retained_record_id is null and c.tenant_id=r.tenant_id and c.session_id=r.session_id and c.id=r.id and (c.seq,c.ordinal)=(r.seq,r.ordinal)
  limit 1
) l on true`;
