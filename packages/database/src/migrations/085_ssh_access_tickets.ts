import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("development_environments")
    .addColumn("terminal_active", "boolean", (column) => column.notNull().defaultTo(false))
    .execute();
  await db.schema
    .createTable("ssh_access_tickets")
    .addColumn("ticket_id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("environment_id", "uuid", (column) => column.notNull())
    .addColumn("secret_sha256", "char(64)", (column) => column.notNull().unique())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "ssh_access_tickets_user_fk",
      ["tenant_id", "user_id"],
      "users",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "ssh_access_tickets_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addForeignKeyConstraint(
      "ssh_access_tickets_environment_fk",
      ["tenant_id", "environment_id"],
      "development_environments",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("restrict"),
    )
    .addCheckConstraint("ssh_access_tickets_secret_valid", sql`secret_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("ssh_access_tickets_expiry_valid", sql`expires_at > created_at`)
    .execute();

  await sql`
    create index ssh_access_tickets_live_idx
      on ssh_access_tickets (expires_at, ticket_id)
      where consumed_at is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("ssh_access_tickets").ifExists().execute();
  await db.schema.alterTable("development_environments").dropColumn("terminal_active").execute();
}
