import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table worker_retirements
    drop constraint worker_retirements_reason_valid,
    add constraint worker_retirements_reason_valid
      check (reason in ('heartbeat_timeout','new_boot','worker_failed'));
    alter table supervisor_connections
    drop constraint supervisor_connections_close_valid,
    add constraint supervisor_connections_close_valid check (
      (state='active' and close_reason is null and closed_at is null) or
      (state='superseded' and close_reason='reconnected' and closed_at is not null) or
      (state='expired' and close_reason='heartbeat_timeout' and closed_at is not null) or
      (state='fenced' and close_reason in ('heartbeat_timeout','new_boot','worker_failed') and closed_at is not null)
    );
    create index workers_failed_retirement_scan on workers(id) where state='failed';
    create index session_leases_unreleased_scan on session_leases(lease_id) where released_at is null;
    create index supervisor_connections_active_scan on supervisor_connections(connection_id) where state='active'
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Control Plane expiry requires a matched application/schema release");
}
