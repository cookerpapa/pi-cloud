import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null) then
        raise exception 'Drain Runs, owners and seals before retiring dormant accounting';
      end if;
      if exists(select 1 from usage_ledger) or exists(select 1 from model_requests)
        or exists(select 1 from environment_operations) then
        raise exception 'Export historical accounting/environment operations before retirement';
      end if;
    end $$;
    drop table usage_ledger;
    drop table model_requests;
    drop table model_rates;
    drop table environment_operations;
    alter table tenant_runtime_policies
      drop constraint tenant_runtime_policies_governance_positive,
      drop column maximum_cost_microusd_per_run,
      drop column daily_token_budget,
      drop column monthly_cost_microusd_budget,
      add constraint tenant_runtime_policies_execution_limits check(
        maximum_model_requests_per_run between 1 and 1024
        and maximum_tool_calls_per_run between 1 and 10000
        and maximum_tool_output_bytes between 1024 and 1048576
        and maximum_run_duration_ms between 1000 and 3600000
        and compaction_reserve_tokens between 1024 and 1000000
        and compaction_keep_recent_tokens between 1024 and 1000000
      );
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Dormant accounting retirement is not reversible");
}
