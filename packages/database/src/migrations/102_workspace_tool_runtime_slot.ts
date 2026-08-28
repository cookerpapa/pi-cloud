import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists tool_broker_workspace_live_idx;

    create unique index tool_broker_workspace_live_unique
      on tool_broker_activations (tenant_id, workspace_id)
      where state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown');
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "102_workspace_tool_runtime_slot restores a physical Volume constraint; restore a pre-migration backup to roll back",
  );
}
