import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sandbox_http_services")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("tenant_id", "uuid", (column) =>
      column.notNull().references("tenants.id").onDelete("restrict"),
    )
    .addColumn("target_kind", "text", (column) => column.notNull())
    .addColumn("target_id", "uuid", (column) => column.notNull())
    .addColumn("workspace_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid")
    .addColumn("development_environment_id", "uuid")
    .addColumn("runtime_id", "text", (column) => column.notNull())
    .addColumn("activation_id", "uuid", (column) => column.notNull())
    .addColumn("last_operation_id", "uuid", (column) => column.notNull())
    .addColumn("port", "integer", (column) => column.notNull())
    .addColumn("protocol", "text", (column) => column.notNull().defaultTo("http"))
    .addColumn("state", "text", (column) => column.notNull().defaultTo("active"))
    .addColumn("first_seen_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("ended_at", "timestamptz")
    .addUniqueConstraint("sandbox_http_services_runtime_port_unique", [
      "tenant_id",
      "target_kind",
      "target_id",
      "runtime_id",
      "port",
    ])
    .addCheckConstraint(
      "sandbox_http_services_target_valid",
      sql`(
        target_kind = 'conversation'
        and session_id = target_id
        and development_environment_id is null
      ) or (
        target_kind = 'development_environment'
        and development_environment_id = target_id
        and session_id is not null
      )`,
    )
    .addCheckConstraint("sandbox_http_services_port_valid", sql`port between 1024 and 65535`)
    .addCheckConstraint("sandbox_http_services_protocol_valid", sql`protocol = 'http'`)
    .addCheckConstraint("sandbox_http_services_state_valid", sql`state in ('active', 'ended')`)
    .addCheckConstraint(
      "sandbox_http_services_settlement_valid",
      sql`(state = 'active' and ended_at is null) or (state = 'ended' and ended_at is not null)`,
    )
    .execute();

  await sql`
    alter table sandbox_http_services
      add constraint sandbox_http_services_workspace_fk
      foreign key (tenant_id, workspace_id)
      references workspaces (tenant_id, id)
      on delete restrict,
      add constraint sandbox_http_services_session_fk
      foreign key (tenant_id, session_id)
      references sessions (tenant_id, id)
      on delete restrict,
      add constraint sandbox_http_services_environment_fk
      foreign key (tenant_id, development_environment_id)
      references development_environments (tenant_id, id)
      on delete restrict
  `.execute(db);

  await db.schema
    .createIndex("sandbox_http_services_active_target")
    .on("sandbox_http_services")
    .columns(["tenant_id", "target_kind", "target_id", "state", "port"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sandbox_http_services").ifExists().execute();
}
