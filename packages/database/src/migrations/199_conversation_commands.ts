import { sql, type Kysely } from "kysely";

/** Run remains one root work item; its initial operation can be a native compact. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
        or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain native writers before conversation command cutover'; end if;
    end $$;
    alter table runs add column operation_kind text not null default 'chat'
      check(operation_kind in ('chat','compact'));
    alter table runs drop constraint runs_input_valid;
    alter table runs add constraint runs_input_valid check(jsonb_typeof(input_uploads)='array' and
      ((operation_kind='chat' and (char_length(input_text)>0 or jsonb_array_length(input_uploads)>0))
       or (operation_kind='compact' and jsonb_array_length(input_uploads)=0)));
    create or replace view conversation_turns as
      select id,tenant_id,session_id,turn_id,input_text,input_uploads,state,mailbox_position,
        created_at,started_at,settled_at,pruned_at,output_seal_id,output_sealed_at,
        output_display_seq,output_display_native_seq,null::text as input_source,operation_kind,stop_reason from runs
      union all
      select e.root_run_id,e.tenant_id,e.child_session_id,e.child_turn_id,
        ''::text,'[]'::jsonb,case e.state when 'preparing' then 'queued' when 'unknown' then 'failed' else e.state end,
        1::bigint,e.created_at,case when s.pi_conversation_id is null then null else e.created_at end,
        e.settled_at,s.pruned_at,null::uuid,e.settled_at,e.output_display_seq,e.output_display_native_seq,
        source.body,'chat'::text,null::text
      from subagent_executions e join sessions s on s.tenant_id=e.tenant_id and s.id=e.child_session_id
      left join pi_durable_log source on source.tenant_id=e.tenant_id and source.session_id=s.pi_session_id
        and source.seq=e.source_sequence and source.record_id=e.source_record_id and source.record_kind=e.source_kind;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Conversation commands require a matched forward upgrade");
}
