import { sql, type Kysely } from "kysely";

const recoveryAwareRuntimeShape = sql`
  (state in ('running', 'paused') and runtime_id is not null and runtime_name is not null)
  or (
    state in ('releasing', 'unknown')
    and ((runtime_id is null and runtime_name is null)
      or (runtime_id is not null and runtime_name is not null))
  )
  or (
    state not in ('running', 'paused', 'releasing', 'unknown')
    and runtime_id is null
    and runtime_name is null
  )
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("development_environments")
    .dropConstraint("development_environments_runtime_shape")
    .execute();
  await db.schema
    .alterTable("development_environments")
    .addCheckConstraint("development_environments_runtime_shape", recoveryAwareRuntimeShape)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update development_environments
       set runtime_id = null,
           runtime_name = null
     where state not in ('running', 'paused')
  `.execute(db);
  await db.schema
    .alterTable("development_environments")
    .dropConstraint("development_environments_runtime_shape")
    .execute();
  await db.schema
    .alterTable("development_environments")
    .addCheckConstraint(
      "development_environments_runtime_shape",
      sql`(state in ('running', 'paused') and runtime_id is not null and runtime_name is not null)
          or (state not in ('running', 'paused') and runtime_id is null and runtime_name is null)`,
    )
    .execute();
}
