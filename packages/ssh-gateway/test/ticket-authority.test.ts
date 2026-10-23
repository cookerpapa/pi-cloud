// Narrow real-PG fixture for the original ticket-consumption query, not a full SSH/VM acceptance.
import { randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createDatabase } from "../../database/src/index.ts";
import { SshTicketAuthority } from "../src/ticket-authority.ts";

it("uses PG time after the ticket lock and consumes each ticket once", async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!endpoint) throw Error("Use isolated test PostgreSQL");
  const name = "review_ssh_" + randomUUID().replaceAll("-", "");
  const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const u = new URL(endpoint);
  u.pathname = "/" + name;
  const db = createDatabase({ connectionString: u.toString(), maxConnections: 4 });
  try {
    await sql`create table sandbox_domains(id text primary key,sandbox_control_base_url text,state text);
  create table development_environments(id uuid primary key,tenant_id uuid,owner_user_id uuid,sandbox_domain_id text,owner_base_url text,state text,terminal_active boolean,desired_state text);
  create table ssh_access_tickets(ticket_id uuid primary key,tenant_id uuid,user_id uuid,session_id uuid,environment_id uuid,secret_sha256 text,expires_at timestamptz,consumed_at timestamptz)`.execute(
      db,
    );
    const id = randomUUID(),
      tenant = randomUUID(),
      user = randomUUID(),
      session = randomUUID(),
      environment = randomUUID(),
      password = `pcssh_${id}.${"x".repeat(43)}`;
    await sql`insert into sandbox_domains values ('review','http://review.test','active')`.execute(
      db,
    );
    await sql`insert into development_environments values(${environment}::uuid,${tenant}::uuid,${user}::uuid,'review','http://review.test','ready',false,'running')`.execute(
      db,
    );
    await sql`insert into ssh_access_tickets values(${id}::uuid,${tenant}::uuid,${user}::uuid,${session}::uuid,${environment}::uuid,${createHash("sha256").update(password).digest("hex")},clock_timestamp()-interval '60 seconds',null)`.execute(
      db,
    );
    const authority = new SshTicketAuthority({ database: db });
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const skew of [-120000, 120000]) {
        vi.setSystemTime(new Date(Date.now() + skew));
        expect(await authority.consume("picloud", password)).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
    await sql`update ssh_access_tickets set expires_at=clock_timestamp()+interval '1 minute'`.execute(
      db,
    );
    const concurrent = await Promise.all([
      authority.consume("picloud", password),
      authority.consume("picloud", password),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    await sql`update ssh_access_tickets set consumed_at=null,expires_at=clock_timestamp()+interval '500 milliseconds'`.execute(
      db,
    );
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      locked = r;
    });
    const blocker = db.transaction().execute(async (tx) => {
      await sql`select ticket_id from ssh_access_tickets for update`.execute(tx);
      locked();
      await gate;
    });
    await entered;
    const pending = authority.consume("picloud", password);
    try {
      await vi.waitFor(async () => {
        const waits = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
          db,
        );
        expect(waits.rows[0]!.n).toBe(1);
      });
      await sql`select pg_sleep(0.55)`.execute(db);
      release();
      await blocker;
      expect(await pending).toBeUndefined();
      const { rows } = await sql<{
        consumed: boolean;
      }>`select consumed_at is not null consumed from ssh_access_tickets`.execute(db);
      expect(rows[0]!.consumed).toBe(false);
    } finally {
      release();
      await blocker;
      await pending;
    }
  } finally {
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
});
