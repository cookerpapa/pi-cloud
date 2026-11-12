import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table workspaces
      add column persistence_state text not null default 'adoption_pending'
        check(persistence_state in ('adoption_pending','uninitialized','initializing','ready')),
      add column persistence_generation text check(persistence_generation ~ '^[a-f0-9]{64}$');
    alter table workspaces alter column persistence_state set default 'uninitialized';
    alter table sandbox_domains add column storage_pool_id text;
    create index workspaces_persistence_pending on workspaces(sandbox_domain_id,id)
      where persistence_state in ('adoption_pending','initializing') and storage_purged_at is null;`.execute(
    db,
  );
}
export async function down(): Promise<void> {
  throw new Error("Workspace persistence authority requires a matched forward update");
}
