import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("session_leases").renameTo("execution_grants").execute();
  await db.schema.alterTable("execution_grants").renameColumn("lease_id", "grant_id").execute();
  await db.schema
    .alterTable("execution_grants")
    .renameColumn("fencing_token", "generation")
    .execute();
  await db.schema
    .alterTable("sessions")
    .renameColumn("last_fencing_token", "last_execution_generation")
    .execute();
  await db.schema
    .alterTable("run_attempts")
    .renameColumn("lease_id", "execution_grant_id")
    .execute();
  await db.schema
    .alterTable("run_attempts")
    .renameColumn("fencing_token", "execution_generation")
    .execute();
  await db.schema
    .alterTable("tool_broker_activations")
    .renameColumn("lease_id", "execution_grant_id")
    .execute();
  await db.schema
    .alterTable("tool_broker_activations")
    .renameColumn("fencing_token", "execution_generation")
    .execute();
  await db.schema
    .alterTable("workspace_terminal_sessions")
    .renameColumn("fencing_token", "generation")
    .execute();

  await db.schema
    .alterTable("execution_grants")
    .addColumn("tenant_id", "uuid")
    .addColumn("project_id", "uuid")
    .addColumn("workspace_id", "uuid")
    .addColumn("run_id", "uuid")
    .addColumn("turn_id", "uuid")
    .addColumn("command_id", "uuid")
    .addColumn("execution_id", "uuid")
    .addColumn("last_event_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .execute();

  await sql`
    update execution_grants as authority
       set tenant_id = session_row.tenant_id,
           project_id = session_row.project_id,
           workspace_id = session_row.workspace_id,
           run_id = run.id,
           turn_id = run.turn_id,
           command_id = run.command_id,
           execution_id = execution.id,
           last_event_seq = execution.last_event_seq
      from sessions as session_row
      join runs as run
        on run.tenant_id = session_row.tenant_id
       and run.session_id = session_row.id
      join run_attempts as execution
        on execution.tenant_id = run.tenant_id
       and execution.run_id = run.id
       and execution.id = run.current_attempt_id
     where authority.session_id = session_row.id
       and execution.execution_grant_id = authority.grant_id
       and execution.execution_generation = authority.generation
  `.execute(db);

  const incomplete = await sql<{ count: string }>`
    select count(*)::text as count
      from execution_grants
     where tenant_id is null
        or project_id is null
        or workspace_id is null
        or run_id is null
        or turn_id is null
        or command_id is null
        or execution_id is null
  `.execute(db);
  if (incomplete.rows[0]?.count !== "0") {
    throw new Error("ExecutionGrant migration found an unbound active Session lease");
  }

  for (const column of [
    "tenant_id",
    "project_id",
    "workspace_id",
    "run_id",
    "turn_id",
    "command_id",
    "execution_id",
  ] as const) {
    await db.schema
      .alterTable("execution_grants")
      .alterColumn(column, (value) => value.setNotNull())
      .execute();
  }

  await db.schema
    .createIndex("execution_grants_expiry")
    .on("execution_grants")
    .column("valid_until")
    .execute();
  await db.schema
    .createIndex("execution_grants_execution_unique")
    .unique()
    .on("execution_grants")
    .column("execution_id")
    .execute();
  await db.schema.dropIndex("session_leases_expiry").ifExists().execute();

  await sql`
    alter table execution_grants
      rename constraint session_leases_pkey to execution_grants_pkey;
    alter table execution_grants
      rename constraint session_leases_lease_id_key to execution_grants_grant_id_key;
    alter table execution_grants
      rename constraint session_leases_fencing_token_positive to execution_grants_generation_positive;
    alter table execution_grants
      rename constraint session_leases_expiry_valid to execution_grants_expiry_valid
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table execution_grants
      rename constraint execution_grants_pkey to session_leases_pkey;
    alter table execution_grants
      rename constraint execution_grants_grant_id_key to session_leases_lease_id_key;
    alter table execution_grants
      rename constraint execution_grants_generation_positive to session_leases_fencing_token_positive;
    alter table execution_grants
      rename constraint execution_grants_expiry_valid to session_leases_expiry_valid
  `.execute(db);
  await db.schema.dropIndex("execution_grants_execution_unique").ifExists().execute();
  await db.schema.dropIndex("execution_grants_expiry").ifExists().execute();
  await db.schema
    .alterTable("execution_grants")
    .dropColumn("last_event_seq")
    .dropColumn("execution_id")
    .dropColumn("command_id")
    .dropColumn("turn_id")
    .dropColumn("run_id")
    .dropColumn("workspace_id")
    .dropColumn("project_id")
    .dropColumn("tenant_id")
    .execute();
  await db.schema
    .alterTable("tool_broker_activations")
    .renameColumn("execution_generation", "fencing_token")
    .execute();
  await db.schema
    .alterTable("workspace_terminal_sessions")
    .renameColumn("generation", "fencing_token")
    .execute();
  await db.schema
    .alterTable("tool_broker_activations")
    .renameColumn("execution_grant_id", "lease_id")
    .execute();
  await db.schema
    .alterTable("run_attempts")
    .renameColumn("execution_generation", "fencing_token")
    .execute();
  await db.schema
    .alterTable("run_attempts")
    .renameColumn("execution_grant_id", "lease_id")
    .execute();
  await db.schema
    .alterTable("sessions")
    .renameColumn("last_execution_generation", "last_fencing_token")
    .execute();
  await db.schema
    .alterTable("execution_grants")
    .renameColumn("generation", "fencing_token")
    .execute();
  await db.schema.alterTable("execution_grants").renameColumn("grant_id", "lease_id").execute();
  await db.schema.alterTable("execution_grants").renameTo("session_leases").execute();
  await db.schema
    .createIndex("session_leases_expiry")
    .on("session_leases")
    .column("valid_until")
    .execute();
}
