import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`lock table execution_targets,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before local execution cutover'; end if;
    end $$;
    alter table execution_targets drop constraint execution_targets_kind_check;
    alter table execution_targets add constraint execution_targets_kind_check check(kind in ('android','linux'));
    create unique index execution_target_one_device_per_session on execution_targets(tenant_id,bound_session_id) where bound_session_id is not null;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Use a drained matched execution-target release");
}
