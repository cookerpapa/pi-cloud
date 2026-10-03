import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspaces
      add column storage_purge_available_at timestamptz not null default clock_timestamp(),
      add column storage_purge_failures integer not null default 0 check(storage_purge_failures between 0 and 16);
    drop index workspaces_pending_storage_purge_idx;
    create index workspaces_pending_storage_purge_idx
      on workspaces(sandbox_domain_id,storage_purge_available_at,deleted_at,id)
      where deleted_at is not null and storage_purged_at is null;
    alter table session_image_objects
      add column cleanup_available_at timestamptz not null default clock_timestamp(),
      add column cleanup_failures integer not null default 0 check(cleanup_failures between 0 and 16);
    drop index session_image_objects_gc;
    create index session_image_objects_gc on session_image_objects(cleanup_available_at,created_at);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore matched resource cleanup code and inventory to roll back");
}
