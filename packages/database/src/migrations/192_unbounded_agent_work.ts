import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (output_seal_id is not null and output_sealed_at is null)) then
        raise exception 'Drain native writers and settle Runs before changing work lifetime';
      end if;
    end $$;
    alter table tenant_runtime_policies
      drop constraint tenant_runtime_policies_execution_limits,
      drop column maximum_run_duration_ms,
      add constraint tenant_runtime_policies_execution_limits check(
        maximum_model_requests_per_run between 1 and 1024
        and maximum_tool_calls_per_run between 1 and 10000
        and maximum_tool_output_bytes between 1024 and 1048576
        and compaction_reserve_tokens between 1024 and 1000000
        and compaction_keep_recent_tokens between 1024 and 1000000
      );
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Agent lifetime requires a matched application/schema release");
}
