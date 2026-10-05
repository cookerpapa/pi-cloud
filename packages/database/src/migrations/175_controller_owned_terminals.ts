import { sql, type Kysely } from "kysely";

/** Terminal ownership follows its controller. These copied timestamps have no
 * current authorization reader and must not couple renewal to resource locks. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table workspace_terminal_sessions
    drop column lease_expires_at, drop column last_heartbeat_at`.execute(db);
  await sql`create index workspace_terminal_owner_live_idx
    on workspace_terminal_sessions(owner_instance_id)
    where state in ('reserved','materializing','active','cleaning')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index workspace_terminal_owner_live_idx;
    alter table workspace_terminal_sessions
      add column lease_expires_at timestamptz not null default clock_timestamp(),
      add column last_heartbeat_at timestamptz not null default clock_timestamp();
    update workspace_terminal_sessions t set lease_expires_at=o.lease_expires_at,
      last_heartbeat_at=o.last_heartbeat_at from sandbox_control_instances o
      where t.owner_instance_id=o.instance_id;
    alter table workspace_terminal_sessions alter column lease_expires_at drop default,
      alter column last_heartbeat_at drop default;
    create index workspace_terminal_owner_live_idx
      on workspace_terminal_sessions(owner_instance_id,lease_expires_at)
      where state in ('reserved','materializing','active','cleaning')`.execute(db);
}
