import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      drop constraint tenant_runtime_policies_limits_positive;

    alter table tenant_runtime_policies
      drop column maximum_concurrent_turns;

    alter table tenant_runtime_policies
      drop column maximum_active_sandboxes;

    alter table tenant_runtime_policies
      add constraint tenant_runtime_policies_limits_positive check (
        maximum_projects > 0
        and maximum_sessions > 0
        and maximum_unsettled_turns > 0
      );

    drop index if exists tool_broker_workspace_live_unique;

    create index tool_broker_workspace_live_idx
      on tool_broker_activations (tenant_id, workspace_id, state);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "101_user_managed_workspace_concurrency removes a product policy; restore a pre-migration backup to roll back",
  );
}
