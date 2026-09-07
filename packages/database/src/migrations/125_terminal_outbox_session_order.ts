import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index outbox_unpublished_session_order on outbox
    (topic, tenant_id, (payload #>> '{scope,sessionId}'), ((payload #>> '{event,seq}')::bigint))
    where published_at is null and aggregate_type = 'session_terminal_event'`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index outbox_unpublished_session_order`.execute(db);
}
