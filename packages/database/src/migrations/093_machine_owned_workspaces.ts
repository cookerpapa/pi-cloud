import { sql, type Kysely } from "kysely";

/** Gives cloud development machine storage an explicit non-elastic identity. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sessions
      drop constraint sessions_sandbox_retention_policy_valid
  `.execute(db);
  await sql`
    alter table sessions
      rename column sandbox_retention_policy to execution_mode
  `.execute(db);
  await sql`
    update sessions
       set execution_mode = case execution_mode
         when 'ephemeral' then 'elastic'
         when 'persistent' then 'development_environment'
       end
  `.execute(db);
  await sql`
    alter table sessions
      alter column execution_mode set default 'elastic',
      add constraint sessions_execution_mode_valid
        check (execution_mode in ('elastic', 'development_environment'))
  `.execute(db);
  await sql`
    alter table workspaces
      drop constraint workspaces_parent_shape,
      drop constraint workspaces_kind_valid
  `.execute(db);
  await sql`
    update workspaces as workspace
       set workspace_kind = 'development_environment'
     where exists (
       select 1
         from development_environments as environment
        where environment.tenant_id = workspace.tenant_id
          and environment.workspace_id = workspace.id
     )
  `.execute(db);
  await sql`
    alter table workspaces
      add constraint workspaces_kind_valid
        check (workspace_kind in ('user', 'development_environment', 'subagent_isolated')),
      add constraint workspaces_parent_shape
        check ((workspace_kind in ('user', 'development_environment') and parent_workspace_id is null)
          or (workspace_kind = 'subagent_isolated' and parent_workspace_id is not null and parent_workspace_id <> id))
  `.execute(db);
  await sql`
    delete from development_environment_operations where action = 'start'
  `.execute(db);
  await sql`
    alter table development_environment_operations
      drop constraint development_environment_operations_action_valid,
      add constraint development_environment_operations_action_valid
        check (action in ('pause', 'resume', 'release'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sessions
      drop constraint sessions_execution_mode_valid,
      alter column execution_mode drop default
  `.execute(db);
  await sql`
    update sessions
       set execution_mode = case execution_mode
         when 'elastic' then 'ephemeral'
         when 'development_environment' then 'persistent'
       end
  `.execute(db);
  await sql`
    alter table sessions
      rename column execution_mode to sandbox_retention_policy
  `.execute(db);
  await sql`
    alter table sessions
      alter column sandbox_retention_policy set default 'ephemeral',
      add constraint sessions_sandbox_retention_policy_valid
        check (sandbox_retention_policy in ('ephemeral', 'persistent'))
  `.execute(db);
  await sql`
    alter table development_environment_operations
      drop constraint development_environment_operations_action_valid,
      add constraint development_environment_operations_action_valid
        check (action in ('start', 'pause', 'resume', 'release'))
  `.execute(db);
  await sql`
    alter table workspaces
      drop constraint workspaces_parent_shape,
      drop constraint workspaces_kind_valid
  `.execute(db);
  await sql`
    update workspaces
       set workspace_kind = 'user'
     where workspace_kind = 'development_environment'
  `.execute(db);
  await sql`
    alter table workspaces
      add constraint workspaces_kind_valid
        check (workspace_kind in ('user', 'subagent_isolated')),
      add constraint workspaces_parent_shape
        check ((workspace_kind = 'user' and parent_workspace_id is null)
          or (workspace_kind = 'subagent_isolated' and parent_workspace_id is not null and parent_workspace_id <> id))
  `.execute(db);
}
