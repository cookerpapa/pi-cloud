// Narrow real-PG fixture for the original ticket-consumption query, not a full SSH/VM acceptance.
import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { SshTicketAuthority } from "../packages/ssh-gateway/src/ticket-authority.ts";

it("characterizes an expired PG ticket accepted by a slow SSH gateway clock", async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!endpoint) throw Error("Use isolated test PostgreSQL");
  const name = "review_ssh_" + randomUUID().replaceAll("-", "");
  const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const u = new URL(endpoint);
  u.pathname = "/" + name;
  const db = createDatabase({ connectionString: u.toString(), maxConnections: 2 });
  try {
    await sql`create table sandbox_domains(id text primary key,sandbox_control_base_url text,state text);
  create table development_environments(id uuid primary key,tenant_id uuid,owner_user_id uuid,sandbox_domain_id text,owner_base_url text,state text,terminal_active boolean);
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
    await sql`insert into development_environments values(${environment}::uuid,${tenant}::uuid,${user}::uuid,'review','http://review.test','running',false)`.execute(
      db,
    );
    await sql`insert into ssh_access_tickets values(${id}::uuid,${tenant}::uuid,${user}::uuid,${session}::uuid,${environment}::uuid,${createHash("sha256").update(password).digest("hex")},clock_timestamp()-interval '60 seconds',null)`.execute(
      db,
    );
    expect(
      await new SshTicketAuthority({ database: db }).consume("picloud", password),
    ).toBeUndefined();
    expect(
      await new SshTicketAuthority({
        database: db,
        clock: () => new Date(Date.now() - 120000),
      }).consume("picloud", password),
    ).toMatchObject({ ticketId: id });
    const { rows } = await sql<{
      expired: boolean;
      consumed: boolean;
    }>`select expires_at<clock_timestamp() expired,consumed_at is not null consumed from ssh_access_tickets`.execute(
      db,
    );
    expect(rows[0]).toEqual({ expired: true, consumed: true });
  } finally {
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
});
