import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    lock table sessions in share row exclusive mode;
    do $$ begin
      if exists(select 1 from sessions where state not in ('cold','idle','running','cancelling','failed')) then
        raise exception 'Unsupported Session lifecycle rows must quiesce before cutover';
      end if;
    end $$;
    alter table sessions drop constraint sessions_state_valid,
      add constraint sessions_state_valid check(state in ('cold','idle','running','cancelling','failed'));
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Restore a matched schema and binaries to roll back Session lifecycle");
}
