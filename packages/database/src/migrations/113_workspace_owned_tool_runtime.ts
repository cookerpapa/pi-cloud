import { sql, type Kysely } from "kysely";

/**
 * Cut over the pre-release Run-owned activation ledger to one physical runtime
 * row per Workspace. Elastic Cubes are ephemeral, so old runtime/operation and
 * Preview rows are intentionally discarded; persistent Workspace Volumes are
 * not touched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from sandbox_http_services;
    delete from tool_broker_operations;
    delete from tool_broker_activations;

    alter table subagent_executions
      drop constraint subagent_executions_workspace_mode_valid;
    update subagent_executions set workspace_mode = 'shared'
      where workspace_mode = 'shared_serialized';
    alter table subagent_executions
      add constraint subagent_executions_workspace_mode_valid
      check (workspace_mode in ('none', 'shared', 'isolated'));

    drop index tool_broker_workspace_live_unique;
    alter table tool_broker_activations rename to tool_broker_workspace_runtimes;
    alter table tool_broker_workspace_runtimes
      rename column activation_id to workspace_runtime_id;

    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_pkey
      to tool_broker_workspace_runtimes_pkey;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_owner_instance_id_fkey
      to tool_broker_workspace_runtimes_owner_instance_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_tenant_id_fkey
      to tool_broker_workspace_runtimes_tenant_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_project_id_fkey
      to tool_broker_workspace_runtimes_project_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_workspace_id_fkey
      to tool_broker_workspace_runtimes_workspace_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_session_id_fkey
      to tool_broker_workspace_runtimes_bootstrap_session_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_turn_id_fkey
      to tool_broker_workspace_runtimes_bootstrap_turn_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_attempt_id_fkey
      to tool_broker_workspace_runtimes_bootstrap_attempt_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint tool_broker_activations_run_fk
      to tool_broker_workspace_runtimes_bootstrap_run_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint tool_broker_activations_sandbox_domain_fk
      to tool_broker_workspace_runtimes_sandbox_domain_fk;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_fence_valid
      to tool_broker_workspace_runtimes_bootstrap_fence_valid;
    alter table tool_broker_workspace_runtimes
      rename constraint sandbox_manager_activations_state_valid
      to tool_broker_workspace_runtimes_state_valid;

    alter index tool_broker_activation_owner_idx
      rename to tool_broker_workspace_runtime_owner_idx;
    alter index tool_broker_activations_tenant_live_idx
      rename to tool_broker_workspace_runtimes_tenant_live_idx;
    create unique index tool_broker_workspace_runtime_live_unique
      on tool_broker_workspace_runtimes (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown');

    alter table tool_broker_operations
      rename constraint sandbox_manager_operations_activation_id_fkey
      to tool_broker_operations_workspace_runtime_fk;
    alter table tool_broker_operations
      rename constraint sandbox_manager_operations_owner_instance_id_fkey
      to tool_broker_operations_owner_instance_fk;
    alter table tool_broker_operations
      rename constraint sandbox_manager_operations_pkey
      to tool_broker_operations_pkey;
    alter table tool_broker_operations
      rename constraint sandbox_manager_operations_state_valid
      to tool_broker_operations_state_valid;
    alter index tool_broker_operation_activation_idx
      rename to tool_broker_operation_workspace_runtime_idx;

    alter table tool_broker_operations rename column activation_id to workspace_runtime_id;
    alter table tool_broker_operations add column tool_binding_id uuid not null;
    alter table tool_broker_operations add column tenant_id uuid not null;
    alter table tool_broker_operations add column session_id uuid not null;
    alter table tool_broker_operations add column run_id uuid not null;
    alter table tool_broker_operations add column attempt_id uuid not null;
    alter table tool_broker_operations add column lease_id uuid not null;
    alter table tool_broker_operations add column fencing_token bigint not null;
    alter table tool_broker_operations
      add constraint tool_broker_operations_tenant_fk
      foreign key (tenant_id) references tenants(id);
    alter table tool_broker_operations
      add constraint tool_broker_operations_session_fk
      foreign key (session_id) references sessions(id);
    alter table tool_broker_operations
      add constraint tool_broker_operations_run_fk
      foreign key (run_id) references runs(id);
    alter table tool_broker_operations
      add constraint tool_broker_operations_attempt_fk
      foreign key (attempt_id) references run_attempts(id);
    alter table tool_broker_operations
      add constraint tool_broker_operations_fence_valid check (fencing_token > 0);

    alter table sandbox_http_services rename column activation_id to tool_binding_id;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "113_workspace_owned_tool_runtime is destructive; restore a pre-migration backup to roll back",
  );
}
