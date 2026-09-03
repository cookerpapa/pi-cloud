import { sql, type Kysely } from "kysely";

/** Name inherited Subagent lanes as branches; Session fork remains a separate operation. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table subagent_executions
      drop constraint subagent_executions_context_mode_valid
  `.execute(db);
  await sql`
    update subagent_executions
       set context_mode = 'branch'
     where context_mode = 'fork'
  `.execute(db);
  await sql`
    alter table subagent_executions
      add constraint subagent_executions_context_mode_valid
        check (context_mode in ('fresh', 'branch'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table subagent_executions
      drop constraint subagent_executions_context_mode_valid
  `.execute(db);
  await sql`
    update subagent_executions
       set context_mode = 'fork'
     where context_mode = 'branch'
  `.execute(db);
  await sql`
    alter table subagent_executions
      add constraint subagent_executions_context_mode_valid
        check (context_mode in ('fresh', 'fork'))
  `.execute(db);
}
