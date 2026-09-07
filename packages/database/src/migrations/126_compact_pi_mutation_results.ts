import { sql, type Kysely } from "kysely";

// Operational idempotency metadata changes; the semantic append-only payload
// and its ordering are not rewritten, removed or reinterpreted.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`update pi_session_log set mutation_result = case
    when mutation_id is null then null
    when mutation_result ? 'items' then jsonb_build_object('format','log-result-v1','shape','items','sequences',
      (select jsonb_agg(item.value -> 'seq' order by item.position) from jsonb_array_elements(mutation_result -> 'items') with ordinality item(value,position)))
    when mutation_result ? 'seq' then jsonb_build_object('format','log-result-v1','shape','one','sequences',jsonb_build_array(mutation_result -> 'seq'))
    else mutation_result end where mutation_result is not null`.execute(db);
  await sql`update pi_session_mutation_results set result = jsonb_build_object('format','append-stamps-v1','items',
    (select jsonb_agg(jsonb_build_object('id', item.value -> 'id', 'seq', item.value -> 'seq', 'timestamp', item.value -> 'timestamp')
      || case when item.value ? 'parentId' then jsonb_build_object('parentId',item.value -> 'parentId') else '{}'::jsonb end order by item.position)
     from jsonb_array_elements(case when result ? 'items' then result -> 'items' else jsonb_build_array(result) end) with ordinality item(value,position)))
    where state='completed' and (result ? 'items' or (result ? 'seq' and result ? 'id'))`.execute(
    db,
  );
}

const restored = sql`case when log.mutation_result ->> 'shape' = 'items' then jsonb_build_object('items',
  (select jsonb_agg(case item.kind when 'entry' then item.payload -> 'entry' else item.payload -> 'record' end order by selected.position)
   from jsonb_array_elements_text(log.mutation_result -> 'sequences') with ordinality selected(seq,position)
   join pi_session_log item on item.tenant_id=log.tenant_id and item.session_id=log.session_id and item.seq=selected.seq::bigint))
  else (select case item.kind when 'entry' then item.payload -> 'entry' else item.payload -> 'record' end
    from pi_session_log item where item.tenant_id=log.tenant_id and item.session_id=log.session_id
      and item.seq=(log.mutation_result -> 'sequences' ->> 0)::bigint) end`;

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update pi_session_mutation_results receipt set result=${restored} from pi_session_log log
    where receipt.mutation_id=log.mutation_id and receipt.result ->> 'format'='append-stamps-v1'`.execute(
    db,
  );
  await sql`update pi_session_log log set mutation_result=${restored}
    where log.mutation_result ->> 'format'='log-result-v1'`.execute(db);
}
