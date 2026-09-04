import { sql, type Kysely } from "kysely";

/**
 * Identifier-only Session log rows cannot be replayed without their historical
 * projections. This pre-release cutover deliberately starts with empty product
 * and Pi Session state instead of retaining a dual-format reader.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`truncate table projects cascade`.execute(db);
  await sql`truncate table pi_sessions cascade`.execute(db);
  await sql`
    update sandbox_domains
       set assigned_workspaces = 0,
           updated_at = now()
  `.execute(db);
  await sql`
    alter table pi_session_log
      add constraint pi_session_log_payload_valid check (
        (kind = 'entry'
          and jsonb_typeof(payload -> 'entry') = 'object'
          and jsonb_typeof(payload -> 'lane') = 'string')
        or (kind = 'record' and jsonb_typeof(payload -> 'record') = 'object')
        or (kind = 'lane'
          and jsonb_typeof(payload -> 'lane') = 'string'
          and payload ? 'leafId')
        or (kind = 'fact' and jsonb_typeof(payload -> 'fact') = 'string')
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table pi_session_log
      drop constraint pi_session_log_payload_valid
  `.execute(db);
}
