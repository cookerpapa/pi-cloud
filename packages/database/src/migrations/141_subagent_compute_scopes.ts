import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists (select 1 from subagent_executions where workspace_mode = 'isolated') then
        raise exception 'Remove retired isolated-Workspace Subagent records before compute-scope cutover; they cannot be reinterpreted as shared storage';
      end if;
      if exists (select 1 from workspaces where workspace_kind = 'subagent_isolated') then
        raise exception 'Remove retired child Workspace copies before shared-Volume cutover';
      end if;
    end $$;
    alter table subagent_executions
      drop constraint subagent_executions_workspace_shape,
      drop constraint subagent_executions_child_workspace_fk,
      drop constraint subagent_executions_workspace_mode_valid,
      drop column child_workspace_id;
    alter table subagent_executions rename column workspace_mode to sandbox_mode;
    alter table subagent_executions add constraint subagent_executions_sandbox_mode_valid
      check (sandbox_mode in ('none', 'shared', 'ephemeral'));
    drop index workspaces_internal_parent_idx;
    alter table workspaces
      drop constraint workspaces_parent_fk,
      drop constraint workspaces_parent_shape,
      drop constraint workspaces_kind_valid,
      drop column parent_workspace_id;
    alter table workspaces add constraint workspaces_kind_valid
      check (workspace_kind in ('user', 'development_environment'));
    alter table sessions drop constraint sessions_working_directory_valid;
    alter table runs drop constraint runs_working_directory_valid;
    alter table sessions add constraint sessions_working_directory_valid
      check (working_directory ~ '^/[^[:cntrl:]]*$'
        and working_directory !~ '(^|/)[.]{1,2}(/|$)'
        and (working_directory = '/' or working_directory !~ '/$'));
    alter table runs add constraint runs_working_directory_valid
      check (working_directory ~ '^/[^[:cntrl:]]*$'
        and working_directory !~ '(^|/)[.]{1,2}(/|$)'
        and (working_directory = '/' or working_directory !~ '/$'));
    alter table sessions add column compute_session_id uuid;
    alter table runs add column compute_session_id uuid;
    alter table tool_broker_workspace_runtimes add column compute_session_id uuid;
    drop index tool_broker_workspace_runtime_live_unique;
    create unique index tool_broker_compute_live_unique
      on tool_broker_workspace_runtimes (tenant_id, workspace_id, compute_session_id) nulls not distinct
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown');
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Shared-volume compute cutover is forward-only; restore a quiescent backup to downgrade",
  );
}
