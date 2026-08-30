import { sql, type Kysely } from "kysely";

/** Replace snapshot/checkpoint vocabulary with the maintained Volume-settlement model. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- File bytes already live on the persistent Workspace Volume. Old rows point at
    -- File-Index payloads that the maintained runtime intentionally does not parse.
    -- Discard only that obsolete metadata/object layer; the next successful Run
    -- writes a fresh lightweight settlement for the existing Volume bytes.
    update sessions
    set workspace_snapshot_key = null,
        current_workspace_version_id = null;
    update workspaces set current_workspace_version_id = null;
    update runs set workspace_base_version_id = null;
    update workspace_operations
    set from_version_id = null,
        to_version_id = null;
    delete from checkpoint_objects as object
    using artifacts as artifact
    where artifact.kind = 'workspace_snapshot'
      and object.object_key = artifact.object_key;
    delete from workspace_versions;
    delete from artifacts where kind = 'workspace_snapshot';

    alter table runs drop constraint runs_state_valid;
    alter table run_attempts drop constraint run_attempts_state_valid;
    alter table run_attempt_transitions drop constraint run_attempt_transitions_from_state_valid;
    alter table run_attempt_transitions drop constraint run_attempt_transitions_to_state_valid;

    update runs set state = 'settling' where state = 'checkpointing';
    update run_attempts set state = 'settling' where state = 'checkpointing';
    update run_attempt_transitions set from_state = 'settling' where from_state = 'checkpointing';
    update run_attempt_transitions set to_state = 'settling' where to_state = 'checkpointing';

    alter table run_attempts rename column checkpoint_revision to settlement_revision;
    alter table run_attempts rename column checkpointing_at to settling_at;
    alter table sessions rename column workspace_snapshot_key to workspace_settlement_key;
    alter table sessions rename column current_workspace_version_id to current_workspace_settlement_id;
    alter table workspaces rename column current_workspace_version_id to current_workspace_settlement_id;
    alter table runs rename column workspace_base_version_id to workspace_base_settlement_id;

    alter table workspace_versions drop constraint workspace_versions_origin_valid;
    alter table workspace_versions drop constraint workspace_versions_execution_shape;
    alter table workspace_versions drop constraint workspace_versions_file_count_valid;
    update workspace_versions set origin_kind = 'settlement' where origin_kind = 'checkpoint';
    alter table workspace_versions rename to workspace_settlements;
    alter table workspace_settlements rename column version_number to settlement_number;
    alter table workspace_settlements rename column parent_version_id to parent_settlement_id;
    alter table workspace_settlements rename column source_version_id to source_settlement_id;
    alter table workspace_settlements rename column workspace_artifact_id to settlement_artifact_id;
    alter table workspace_settlements drop column file_count;

    alter table workspace_settlements rename constraint workspace_versions_pkey
      to workspace_settlements_pkey;
    alter table workspace_settlements rename constraint workspace_versions_tenant_id_unique
      to workspace_settlements_tenant_id_unique;
    alter table workspace_settlements rename constraint workspace_versions_session_id_unique
      to workspace_settlements_session_id_unique;
    alter table workspace_settlements rename constraint workspace_versions_session_number_unique
      to workspace_settlements_session_number_unique;
    alter table workspace_settlements rename constraint workspace_versions_workspace_fk
      to workspace_settlements_workspace_fk;
    alter table workspace_settlements rename constraint workspace_versions_session_fk
      to workspace_settlements_session_fk;
    alter table workspace_settlements rename constraint workspace_versions_parent_fk
      to workspace_settlements_parent_fk;
    alter table workspace_settlements rename constraint workspace_versions_source_fk
      to workspace_settlements_source_fk;
    alter table workspace_settlements rename constraint workspace_versions_run_fk
      to workspace_settlements_run_fk;
    alter table workspace_settlements rename constraint workspace_versions_attempt_fk
      to workspace_settlements_attempt_fk;
    alter table workspace_settlements rename constraint workspace_versions_turn_fk
      to workspace_settlements_turn_fk;
    alter table workspace_settlements rename constraint workspace_versions_workspace_artifact_fk
      to workspace_settlements_settlement_artifact_fk;
    alter table workspace_settlements rename constraint workspace_versions_number_positive
      to workspace_settlements_number_positive;
    alter table workspace_settlements rename constraint workspace_versions_revision_valid
      to workspace_settlements_revision_valid;
    alter table workspace_settlements rename constraint workspace_versions_state_valid
      to workspace_settlements_state_valid;
    alter table workspace_settlements rename constraint workspace_versions_settlement_shape
      to workspace_settlements_shape;
    alter index workspace_versions_session_created_idx
      rename to workspace_settlements_session_created_idx;
    alter index workspace_versions_one_run rename to workspace_settlements_one_run;

    alter table sessions rename constraint sessions_current_workspace_version_fk
      to sessions_current_workspace_settlement_fk;
    alter table workspaces rename constraint workspaces_current_workspace_version_fk
      to workspaces_current_workspace_settlement_fk;
    alter table runs rename constraint runs_workspace_base_version_fk
      to runs_workspace_base_settlement_fk;

    alter table workspace_operations rename column from_version_id to from_settlement_id;
    alter table workspace_operations rename column to_version_id to to_settlement_id;
    alter table workspace_operations rename constraint workspace_operations_from_version_fk
      to workspace_operations_from_settlement_fk;
    alter table workspace_operations rename constraint workspace_operations_to_version_fk
      to workspace_operations_to_settlement_fk;

    alter table artifacts drop constraint artifacts_kind_valid;
    update artifacts set kind = 'workspace_settlement' where kind = 'workspace_snapshot';
    alter table artifacts add constraint artifacts_kind_valid
      check (kind in ('workspace_settlement', 'tool_output', 'report', 'crash_bundle'));

    alter table checkpoint_objects rename to runtime_objects;
    alter table runtime_objects rename constraint checkpoint_objects_pkey to runtime_objects_pkey;
    alter table runtime_objects rename constraint checkpoint_objects_key_valid to runtime_objects_key_valid;
    alter table runtime_objects rename constraint checkpoint_objects_sha_valid to runtime_objects_sha_valid;
    alter table runtime_objects rename constraint checkpoint_objects_size_valid to runtime_objects_size_valid;

    alter table runs add constraint runs_state_valid check (state in (
      'queued', 'claimed', 'provisioning', 'restoring', 'running', 'settling',
      'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded'
    ));
    alter table run_attempts add constraint run_attempts_state_valid check (state in (
      'claimed', 'provisioning', 'restoring', 'running', 'settling',
      'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded'
    ));
    alter table run_attempt_transitions add constraint run_attempt_transitions_from_state_valid
      check (from_state is null or from_state in (
        'claimed', 'provisioning', 'restoring', 'running', 'settling',
        'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded'
      ));
    alter table run_attempt_transitions add constraint run_attempt_transitions_to_state_valid
      check (to_state in (
        'claimed', 'provisioning', 'restoring', 'running', 'settling',
        'cancel_requested', 'completed', 'failed', 'cancelled', 'timed_out', 'superseded'
      ));

    alter table workspace_settlements add constraint workspace_settlements_origin_valid
      check (origin_kind in ('settlement', 'fork', 'migration', 'promotion'));
    alter table workspace_settlements add constraint workspace_settlements_execution_shape
      check (
        (origin_kind = 'settlement' and run_id is not null and attempt_id is not null and turn_id is not null)
        or (origin_kind in ('fork', 'migration', 'promotion') and run_id is null and attempt_id is null and turn_id is null)
      );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "112_live_workspace_settlement is destructive; restore a pre-migration backup to roll back",
  );
}
