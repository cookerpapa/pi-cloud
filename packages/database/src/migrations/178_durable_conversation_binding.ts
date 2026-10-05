import { sql, type Kysely } from "kysely";

/** Pre-release native format cutover. The inspected deployment has no Sessions;
 * recheck under locks instead of silently deleting newly-created user history. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table sessions,pi_sessions,runs,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from sessions) or exists(select 1 from pi_sessions)
        or exists(select 1 from session_leases where released_at is null)
      then raise exception 'Durable format cutover requires an empty, drained Session store; preserve/export existing conversations first';
      end if;
    end $$;
    drop table pi_session_open_operations;
    drop table pi_session_labels;
    drop table pi_session_lanes;
    drop table pi_session_log;
    alter table sessions drop column pi_session_lane;
    alter table sessions add column pi_conversation_id bigint default 1 check(pi_conversation_id>0);
    alter table pi_sessions drop column next_seq;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error(
    "Restore matching drained application and database artifacts before reverting the native format",
  );
}
