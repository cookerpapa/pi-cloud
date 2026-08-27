import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from sessions where state = 'waiting_approval')
         or exists (select 1 from turns where state = 'waiting_approval')
         or exists (select 1 from turns where input_kind = 'continue')
         or exists (select 1 from commands where kind = 'approval.resolve') then
        raise exception 'dormant approval state still contains live data';
      end if;
    end $$
  `.execute(db);

  await db.schema.dropTable("approvals").ifExists().execute();
  await db.schema.dropTable("agent_nodes").ifExists().execute();
  await db.schema.dropTable("test_results").ifExists().execute();

  await db.schema.alterTable("sessions").dropConstraint("sessions_state_valid").execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_state_valid",
      sql`state in ('cold', 'starting', 'idle', 'running', 'cancelling', 'failed', 'recovering', 'evicting')`,
    )
    .execute();
  await db.schema.alterTable("turns").dropConstraint("turns_state_valid").execute();
  await db.schema
    .alterTable("turns")
    .addCheckConstraint(
      "turns_state_valid",
      sql`state in ('queued', 'dispatching', 'running', 'cancelling', 'completed', 'failed', 'cancelled')`,
    )
    .execute();
  await db.schema.alterTable("turns").dropConstraint("turns_input_valid").execute();
  await db.schema
    .alterTable("turns")
    .addCheckConstraint(
      "turns_input_valid",
      sql`input_kind = 'prompt' and input_text is not null and char_length(input_text) > 0`,
    )
    .execute();
  await db.schema.alterTable("commands").dropConstraint("commands_kind_valid").execute();
  await db.schema
    .alterTable("commands")
    .addCheckConstraint(
      "commands_kind_valid",
      sql`kind in ('turn.execute', 'turn.cancel', 'turn.steer')`,
    )
    .execute();
}

export async function down(): Promise<void> {
  throw new Error("Dormant approval-graph removal is an irreversible pre-release migration");
}
