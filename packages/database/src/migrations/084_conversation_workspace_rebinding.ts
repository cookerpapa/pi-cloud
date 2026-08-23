import { sql, type Kysely } from "kysely";

/**
 * Conversation history is a durable knowledge resource and must outlive the
 * mutable filesystem it was last attached to. Rebinding is recorded as an
 * idempotent product operation while historical Runs keep their original
 * Workspace foreign keys.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_delete_operations")
    .addColumn("detached_session_count", "integer", (column) => column.notNull().defaultTo(0))
    .execute();
  await sql`
    alter table workspace_delete_operations
    add constraint workspace_delete_operations_detached_count_nonnegative
    check (detached_session_count >= 0)
  `.execute(db);
  await db.schema
    .alterTable("development_environments")
    .addColumn("agent_activation_id", "uuid")
    .execute();
  await sql`
    create unique index development_environments_agent_activation_unique
      on development_environments (agent_activation_id)
      where agent_activation_id is not null
  `.execute(db);

  await db.schema
    .createTable("conversation_workspace_rebind_operations")
    .addColumn("operation_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) =>
      column.notNull().references("tenants.id").onDelete("restrict"),
    )
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("from_workspace_id", "uuid", (column) =>
      column.notNull().references("workspaces.id").onDelete("restrict"),
    )
    .addColumn("to_workspace_id", "uuid", (column) =>
      column.notNull().references("workspaces.id").onDelete("restrict"),
    )
    .addColumn("idempotency_key", "text", (column) => column.notNull())
    .addColumn("request_sha256", "char(64)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "conversation_workspace_rebind_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addUniqueConstraint("conversation_workspace_rebind_scope_key_unique", [
      "tenant_id",
      "session_id",
      "idempotency_key",
    ])
    .execute();

  await db.schema
    .createIndex("conversation_workspace_rebind_session_idx")
    .on("conversation_workspace_rebind_operations")
    .columns(["tenant_id", "session_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("conversation_workspace_rebind_operations").ifExists().execute();
  await db.schema
    .dropIndex("development_environments_agent_activation_unique")
    .ifExists()
    .execute();
  await db.schema
    .alterTable("development_environments")
    .dropColumn("agent_activation_id")
    .execute();
  await db.schema
    .alterTable("workspace_delete_operations")
    .dropConstraint("workspace_delete_operations_detached_count_nonnegative")
    .ifExists()
    .execute();
  await db.schema
    .alterTable("workspace_delete_operations")
    .dropColumn("detached_session_count")
    .execute();
}
