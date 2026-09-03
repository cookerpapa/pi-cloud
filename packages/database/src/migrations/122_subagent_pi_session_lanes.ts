import { sql, type Kysely } from "kysely";

/** Bind every product Session to one lane in a durable Pi Session tree. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sessions
      add column pi_session_id text,
      add column pi_session_lane text
  `.execute(db);
  await sql`
    update sessions
       set pi_session_id = id::text,
           pi_session_lane = 'main'
  `.execute(db);
  await sql`
    alter table sessions
      alter column pi_session_id set not null,
      alter column pi_session_lane set not null,
      add constraint sessions_pi_session_lane_valid
        check (length(pi_session_lane) between 1 and 128)
  `.execute(db);
  await sql`
    create unique index sessions_pi_lane_identity_unique
        on sessions (tenant_id, pi_session_id, pi_session_lane)
  `.execute(db);
  await sql`
    alter table subagent_executions
      add column pi_context_base_entry_id text
  `.execute(db);
  await sql`
    update subagent_executions execution
       set pi_context_base_entry_id = (
         select ref.id
           from pi_session_entry_refs ref
          where ref.tenant_id = execution.tenant_id
            and ref.session_id = execution.child_session_id::text
            and ref.timestamp_ms < extract(epoch from execution.created_at) * 1000
          order by ref.seq desc
          limit 1
       )
     where execution.context_mode = 'fork'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table subagent_executions drop column pi_context_base_entry_id`.execute(db);
  await sql`drop index sessions_pi_lane_identity_unique`.execute(db);
  await sql`
    alter table sessions
      drop constraint sessions_pi_session_lane_valid,
      drop column pi_session_lane,
      drop column pi_session_id
  `.execute(db);
}
