import { sql, type Kysely } from "kysely";

/** Persist one-use OAuth state while keeping Git credentials in Workspace storage. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("workspace_source_repositories").ifExists().execute();
  await db.schema
    .createTable("workspace_git_oauth_requests")
    .addColumn("state_sha256", "char(64)", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) => column.notNull().references("tenants.id"))
    .addColumn("user_id", "uuid", (column) => column.notNull())
    .addColumn("issue_job_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("code_verifier", "varchar(128)", (column) => column.notNull())
    .addColumn("redirect_uri", "varchar(2048)", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "workspace_git_oauth_requests_user_fk",
      ["tenant_id", "user_id"],
      "users",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "workspace_git_oauth_requests_job_fk",
      ["tenant_id", "issue_job_id"],
      "source_control_issue_jobs",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addForeignKeyConstraint(
      "workspace_git_oauth_requests_workspace_fk",
      ["tenant_id", "workspace_id"],
      "workspaces",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint("workspace_git_oauth_state_valid", sql`state_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint(
      "workspace_git_oauth_verifier_valid",
      sql`code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'`,
    )
    .addCheckConstraint("workspace_git_oauth_expiry_valid", sql`expires_at > created_at`)
    .execute();
  await db.schema
    .createIndex("workspace_git_oauth_requests_expiry_idx")
    .on("workspace_git_oauth_requests")
    .column("expires_at")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "111_workspace_git_oauth_requests is destructive; restore a pre-migration backup to roll back",
  );
}
