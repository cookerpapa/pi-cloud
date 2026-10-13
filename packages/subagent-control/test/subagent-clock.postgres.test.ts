import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@pi-cloud/database";
import { PostgresSubagentSupervisorChannel } from "../src/postgres-subagent-supervisor-channel.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Subagent PG clock decisions", () => {
  let admin: ReturnType<typeof createDatabase>,
    database: ReturnType<typeof createDatabase>,
    url: string;
  const name = `subagent_clock_${randomUUID().replaceAll("-", "")}`;
  const tenant = randomUUID(),
    parent = randomUUID(),
    session = randomUUID(),
    run = randomUUID(),
    execution = randomUUID();
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const parsed = new URL(endpoint!);
    parsed.pathname = "/" + name;
    url = parsed.toString();
    database = createDatabase({ connectionString: url, maxConnections: 3 });
    // Isolate real production methods' deadline SQL from unrelated admission FKs.
    await sql
      .raw(
        `
      create table subagent_conversations(id uuid primary key,tenant_id uuid,parent_session_id uuid,child_session_id uuid,root_run_id uuid);
      create view subagent_executions as select *, 'running'::text state from subagent_conversations;
      create table subagent_supervisor_requests(id uuid primary key,tenant_id uuid,execution_id uuid,reason text,message text,expects_reply bool,interview jsonb,reply_message text,created_at timestamptz default clock_timestamp(),expires_at timestamptz,replied_at timestamptz);
    `,
      )
      .execute(database);
    await sql`insert into subagent_conversations values(${execution}::uuid,${tenant}::uuid,${parent}::uuid,${session}::uuid,${run}::uuid)`.execute(
      database,
    );
  });
  afterAll(async () => {
    vi.useRealTimers();
    await database?.destroy();
    try {
      await sql`drop database if exists ${sql.id(name)}`.execute(admin);
    } finally {
      await admin?.destroy();
    }
  });
  const channel = () => new PostgresSubagentSupervisorChannel(database);
  const contact = () =>
    channel().contact({
      tenantId: tenant,
      childSessionId: session,
      rootRunId: run,
      reason: "need_decision",
      message: "fixture",
    });
  it.each([-60000, 60000])("uses PG for request expiry with app skew %i", async (skew) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + skew);
    try {
      const request = await contact();
      const {
        rows: [expiry],
      } = await sql<{
        remaining: number;
      }>`select extract(epoch from expires_at-clock_timestamp())::float8 remaining from subagent_supervisor_requests where id=${request.requestId}::uuid`.execute(
        database,
      );
      expect(expiry!.remaining).toBeGreaterThan(590);
      expect(expiry!.remaining).toBeLessThanOrEqual(600);
      await expect(
        channel().reply({
          tenantId: tenant,
          parentSessionId: parent,
          requestId: request.requestId,
          message: "answer",
        }),
      ).resolves.toMatchObject({ replyMessage: "answer" });
      await sql`update subagent_supervisor_requests set expires_at=clock_timestamp()-interval '1 second' where id=${request.requestId}::uuid`.execute(
        database,
      );
      await expect(
        channel().reply({
          tenantId: tenant,
          parentSessionId: parent,
          requestId: request.requestId,
          message: "answer",
        }),
      ).resolves.toMatchObject({ replyMessage: "answer" });
      const expired = await contact();
      await sql`update subagent_supervisor_requests set expires_at=clock_timestamp()-interval '1 second' where id=${expired.requestId}::uuid`.execute(
        database,
      );
      await expect(
        channel().reply({
          tenantId: tenant,
          parentSessionId: parent,
          requestId: expired.requestId,
          message: "late",
        }),
      ).rejects.toThrow("expired");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rechecks the deadline after waiting for the request lock", async () => {
    const request = await contact(),
      locker = new Client({ connectionString: url });
    await sql`update subagent_supervisor_requests set expires_at=clock_timestamp()+interval '500 milliseconds' where id=${request.requestId}::uuid`.execute(
      database,
    );
    await locker.connect();
    try {
      await locker.query("begin");
      await locker.query("select id from subagent_supervisor_requests where id=$1 for update", [
        request.requestId,
      ]);
      const reply = channel().reply({
        tenantId: tenant,
        parentSessionId: parent,
        requestId: request.requestId,
        message: "late",
      });
      const rejected = expect(reply).rejects.toThrow("expired");
      await delay(700);
      await locker.query("commit");
      await rejected;
    } finally {
      await locker.end();
    }
  });
});
