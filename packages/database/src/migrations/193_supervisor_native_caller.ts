import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  // Matched development upgrade after writer quiescence. Old request rows do
  // not identify a resumable waiter; never infer one from the child alone.
  await sql`
    truncate subagent_supervisor_requests;
    alter table subagent_supervisor_requests
      add column native_task_id bigint not null check (native_task_id > 0),
      add column writer_id uuid not null;
    create index subagent_supervisor_pending_caller
      on subagent_supervisor_requests(tenant_id,writer_id,native_task_id)
      where expects_reply and reply_message is null;
  `.execute(db);
}

export async function down<DB>(_db: Kysely<DB>): Promise<void> {
  throw new Error("Supervisor caller identity requires a drained matched upgrade");
}
