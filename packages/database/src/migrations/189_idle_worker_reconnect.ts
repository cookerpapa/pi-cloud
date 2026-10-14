import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table supervisor_connections
    drop constraint supervisor_connections_state_valid,
    drop constraint supervisor_connections_close_valid,
    add constraint supervisor_connections_state_valid
      check (state in ('active','superseded','expired','fenced')),
    add constraint supervisor_connections_close_valid check (
      (state='active' and close_reason is null and closed_at is null) or
      (state='superseded' and close_reason='reconnected' and closed_at is not null) or
      (state='expired' and close_reason='heartbeat_timeout' and closed_at is not null) or
      (state='fenced' and close_reason in ('heartbeat_timeout','new_boot') and closed_at is not null)
    )`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Idle Worker reconnect requires a matched application/schema release");
}
