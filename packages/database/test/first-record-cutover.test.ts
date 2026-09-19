import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase } from "../src/index.ts";
import { up } from "../src/migrations/143_first_record_execution.ts";

let pg: PGlite, socket: PGLiteSocketServer, db: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await sql`create table runs(state text); create table session_leases(id int);
    create table run_attempts(output_seal_id text,output_sealed_at timestamptz,output_open_offset bigint);
    create table outbox(aggregate_type text,published_at timestamptz);
    create table pi_session_log(text text); insert into pi_session_log values('retained history');`.execute(
    db,
  );
});
beforeEach(async () => {
  await sql`truncate runs,session_leases,run_attempts,outbox`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

it.each([
  "insert into runs values('running')",
  "insert into session_leases values(1)",
  "insert into run_attempts values('seal',null,5)",
  "insert into outbox values('session_terminal_event',null)",
])("refuses an undrained cutover: %s", async (statement) => {
  await sql.raw(statement).execute(db);
  await expect(up(db)).rejects.toThrow(/Drain executions, Session leases and seals/);
  await expect(sql`select output_open_offset from run_attempts`.execute(db)).resolves.toBeDefined();
});

it("drops only the unused opening column after draining, without resetting history", async () => {
  await sql`insert into runs values('completed');
    insert into run_attempts values('seal',clock_timestamp(),5);
    insert into outbox values('session_terminal_event',clock_timestamp())`.execute(db);
  await up(db);
  expect((await sql<{ text: string }>`select text from pi_session_log`.execute(db)).rows).toEqual([
    { text: "retained history" },
  ]);
  expect((await sql<{ count: string }>`select count(*) from runs`.execute(db)).rows[0]?.count).toBe(
    "1",
  );
  await expect(sql`select output_open_offset from run_attempts`.execute(db)).rejects.toThrow(
    /does not exist/,
  );
});
