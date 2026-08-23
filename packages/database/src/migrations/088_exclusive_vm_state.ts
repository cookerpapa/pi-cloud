import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("development_environments")
    .addColumn("runtime_capsule", "text")
    .execute();
  await db.schema.alterTable("sessions").addColumn("development_environment_id", "uuid").execute();
  await db.schema
    .alterTable("sessions")
    .addForeignKeyConstraint(
      "sessions_development_environment_fk",
      ["tenant_id", "development_environment_id"],
      "development_environments",
      ["tenant_id", "id"],
    )
    .execute();
  await sql`
    update sessions session_row
       set development_environment_id = environment.id
      from development_environments environment
     where environment.tenant_id = session_row.tenant_id
       and environment.workspace_id = session_row.workspace_id
       and session_row.sandbox_retention_policy = 'persistent'
       and environment.state <> 'released'
  `.execute(db);
  await sql`
    alter table development_environments
      add constraint development_environments_runtime_capsule_bounded
        check (runtime_capsule is null or octet_length(runtime_capsule) between 64 and 131072)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_development_environment_fk")
    .execute();
  await db.schema.alterTable("sessions").dropColumn("development_environment_id").execute();
  await sql`
    alter table development_environments
      drop constraint development_environments_runtime_capsule_bounded
  `.execute(db);
  await db.schema.alterTable("development_environments").dropColumn("runtime_capsule").execute();
}
