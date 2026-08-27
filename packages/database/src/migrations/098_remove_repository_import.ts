import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspaces")
    .addColumn("seed_kind", "text", (column) => column.notNull().defaultTo("empty"))
    .execute();
  await sql`
    update workspaces as workspace
       set seed_kind = 'sample_java'
      from workspace_sources as source
     where source.tenant_id = workspace.tenant_id
       and source.workspace_id = workspace.id
       and source.kind = 'sample_java'
  `.execute(db);
  await db.schema
    .alterTable("workspaces")
    .addCheckConstraint("workspaces_seed_kind_valid", sql`seed_kind in ('empty', 'sample_java')`)
    .execute();

  await db.schema.dropTable("workspace_repository_sources").ifExists().execute();
  await db.schema.dropTable("workspace_sources").ifExists().execute();
  await db.schema.dropTable("github_pull_request_deliveries").ifExists().execute();
  await db.schema.dropTable("github_webhook_deliveries").ifExists().execute();
  await db.schema.dropTable("github_repositories").ifExists().execute();
  await db.schema.dropTable("github_app_installations").ifExists().execute();

  await sql`alter table runs drop constraint if exists runs_source_set_snapshot_valid`.execute(db);
  await db.schema.alterTable("runs").dropColumn("source_set_snapshot").execute();
  await db.schema.alterTable("workspaces").dropColumn("object_snapshot_key").execute();
}

export async function down(): Promise<void> {
  throw new Error("Repository-import removal is an irreversible pre-release migration");
}
