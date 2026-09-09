import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table tool_broker_binding_routes (
    binding_id uuid not null,
    tenant_id uuid not null references tenants(id) on delete cascade,
    attempt_id uuid not null references run_attempts(id) on delete cascade,
    owner_instance_id uuid not null references tool_broker_instances(instance_id) on delete cascade,
    primary key (attempt_id, binding_id)
  );
  create index tool_broker_binding_routes_attempt on tool_broker_binding_routes(attempt_id);
  create index tool_broker_binding_routes_owner on tool_broker_binding_routes(owner_instance_id)`.execute(
    db,
  );
}
export async function down(): Promise<void> {
  throw new Error("Restore a drained backup to undo the Tool routing cutover");
}
