import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createDatabase } from "../src/index.ts";
import { up } from "../src/migrations/144_ready_run_admission.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("ready-Run cutover", () => {
  const name = `pi_ready_cutover_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof createDatabase>, db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    await sql`create table runs(id uuid default gen_random_uuid(),tenant_id uuid,session_id uuid,
        state text,available_at timestamptz,queued_at timestamptz);
      create table sessions(id uuid,tenant_id uuid,pi_session_id text);
      create table pi_sessions(id text,tenant_id uuid);
      create table session_leases(id int);
      create table run_attempts(id uuid,tenant_id uuid,run_id uuid,output_seal_id text,output_sealed_at timestamptz,output_publication jsonb);
      create table outbox(aggregate_type text,published_at timestamptz);
      create table pi_session_log(text text);
      insert into pi_session_log values('retained history');
      create function pi_cloud_notify_run_queue() returns trigger language plpgsql as $$begin return new; end$$;
      create trigger runs_notify_run_queue after insert on runs for each row execute function pi_cloud_notify_run_queue();
      create index runs_ready_queue_idx on runs(id);`.execute(db);
  });
  beforeEach(async () => {
    await sql`truncate runs,session_leases,run_attempts,outbox`.execute(db);
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  });
  it.each([
    "insert into runs(state) values('queued')",
    "insert into runs(state) values('running')",
    "insert into session_leases values(1)",
    "insert into run_attempts(output_seal_id) values('seal')",
    "insert into run_attempts(output_publication) values('{}')",
    "insert into outbox values('session_terminal_event',null)",
  ])("refuses a pending cutover: %s", async (statement) => {
    await sql.raw(statement).execute(db);
    await expect(up(db as unknown as Kysely<unknown>)).rejects.toThrow(/Drain accepted input/);
    expect(
      (
        await sql<{ n: string }>`select count(*) n from information_schema.columns
      where table_name='runs' and column_name='ready_at'`.execute(db)
      ).rows[0]!.n,
    ).toBe("0");
  });
  it("keeps history and counts only committed admission/first closure, never replay", async () => {
    await sql`insert into runs(state) values('completed')`.execute(db);
    await up(db as unknown as Kysely<unknown>);
    expect((await sql<{ text: string }>`select text from pi_session_log`.execute(db)).rows).toEqual(
      [{ text: "retained history" }],
    );
    const tenant = randomUUID(),
      session = randomUUID(),
      run = randomUUID(),
      attempt = randomUUID();
    await sql`insert into pi_sessions(id,tenant_id) values(${session},${tenant}::uuid)`.execute(db);
    await sql`insert into sessions values(${session}::uuid,${tenant}::uuid,${session})`.execute(db);
    await sql`insert into runs(id,tenant_id,session_id,state)
      values(${run}::uuid,${tenant}::uuid,${session}::uuid,'running')`.execute(db);
    const count = async () =>
      (
        await sql<{ n: string }>`select unsealed_runs n from pi_sessions
      where id=${session}`.execute(db)
      ).rows[0]!.n;
    const insert = (tx: Kysely<unknown>) =>
      sql`insert into run_attempts(id,tenant_id,run_id)
      values(${attempt}::uuid,${tenant}::uuid,${run}::uuid)`.execute(tx);
    await expect(
      db.transaction().execute(async (tx) => {
        await insert(tx as unknown as Kysely<unknown>);
        throw new Error("admission rollback");
      }),
    ).rejects.toThrow("admission rollback");
    expect(await count()).toBe("0");
    await insert(db as unknown as Kysely<unknown>);
    expect(await count()).toBe("1");
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`update run_attempts set output_sealed_at=clock_timestamp() where id=${attempt}::uuid`.execute(
          tx,
        );
        throw new Error("seal rollback");
      }),
    ).rejects.toThrow("seal rollback");
    expect(await count()).toBe("1");
    for (let i = 0; i < 2; i++) {
      await sql`update run_attempts set output_sealed_at=clock_timestamp() where id=${attempt}::uuid`.execute(
        db,
      );
      expect(await count()).toBe("0");
    }
  });
});
