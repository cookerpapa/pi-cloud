import { sql, type Kysely } from "kysely";

const absoluteMachineDirectory = sql`
  working_directory ~ '^/[^[:cntrl:]]*$'
  and working_directory !~ '(^|/)\.{1,2}(/|$)'
  and (working_directory = '/' or working_directory !~ '/$')
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_working_directory_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint("sessions_working_directory_valid", absoluteMachineDirectory)
    .execute();
  await db.schema.alterTable("runs").dropConstraint("runs_working_directory_valid").execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint("runs_working_directory_valid", absoluteMachineDirectory)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("runs").dropConstraint("runs_working_directory_valid").execute();
  await db.schema
    .alterTable("runs")
    .addCheckConstraint(
      "runs_working_directory_valid",
      sql`working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$'`,
    )
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_working_directory_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .addCheckConstraint(
      "sessions_working_directory_valid",
      sql`working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$'`,
    )
    .execute();
}
