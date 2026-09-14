import { sql, type Kysely } from "kysely";

/** Only obsolete references/output archives are removed, never user files or native history. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_operations drop column from_settlement_id, drop column to_settlement_id;
    alter table sessions drop column current_workspace_settlement_id, drop column workspace_settlement_key;
    alter table workspaces drop column current_workspace_settlement_id;
    alter table runs drop column workspace_base_settlement_id;
    alter table run_attempts drop column settlement_revision;
    alter table tool_broker_workspace_runtimes drop column workspace_revision;
    drop table workspace_settlements;
    drop table artifacts;
    drop table runtime_objects;
    alter table environment_validations alter column run_id drop not null, alter column attempt_id drop not null;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "138_direct_workspace_storage removes unused archives; restore a backup to roll back",
  );
}
