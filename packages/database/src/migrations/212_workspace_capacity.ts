import { sql, type Kysely } from "kysely";
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspaces
      add column capacity_bytes bigint not null default 34359738368 check(capacity_bytes>=1073741824),
      add column capacity_revision bigint not null default 1 check(capacity_revision>0),
      add column capacity_pending boolean not null default false;
    create index workspace_capacity_pending on workspaces(sandbox_domain_id,id)
      where capacity_pending and deleted_at is null;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Workspace capacity requires matched physical storage reconciliation");
}
