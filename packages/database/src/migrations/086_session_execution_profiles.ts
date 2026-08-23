import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("working_directory", "text", (column) => column.notNull().defaultTo("/workspace"))
    .addColumn("sandbox_profile_key", "text", (column) => column.notNull().defaultTo("standard"))
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_working_directory_valid",
      sql`working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$'`,
    )
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_sandbox_profile_valid",
      sql`sandbox_profile_key in ('starter', 'standard', 'performance')`,
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addColumn("working_directory", "text", (column) => column.notNull().defaultTo("/workspace"))
    .addColumn("sandbox_profile_key", "text", (column) => column.notNull().defaultTo("standard"))
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_working_directory_valid",
      sql`working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$'`,
    )
    .execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_sandbox_profile_valid",
      sql`sandbox_profile_key in ('starter', 'standard', 'performance')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("runs").dropConstraint("runs_sandbox_profile_valid").execute();
  await db.schema.alterTable("runs").dropConstraint("runs_working_directory_valid").execute();
  await db.schema.alterTable("runs").dropColumn("sandbox_profile_key").execute();
  await db.schema.alterTable("runs").dropColumn("working_directory").execute();
  await db.schema.alterTable("sessions").dropConstraint("sessions_sandbox_profile_valid").execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_working_directory_valid")
    .execute();
  await db.schema.alterTable("sessions").dropColumn("sandbox_profile_key").execute();
  await db.schema.alterTable("sessions").dropColumn("working_directory").execute();
}
