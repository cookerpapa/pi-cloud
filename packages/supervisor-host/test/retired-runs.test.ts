import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findRetiredRuns } from "../src/retired-runs.ts";

let engine: PGlite, server: PGLiteSocketServer, db: Kysely<Database>;
beforeAll(async () => {
  engine = await PGlite.create();
  server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0, maxConnections: 2 });
  await server.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await sql`create table runs(id uuid primary key,state text,output_sealed_at timestamptz);
 create table turn_control_requests(target_run_id uuid,state text);`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
  await server?.stop();
  await engine?.close();
});

it("requires terminal Run, committed seal and terminal controls, not a local timeout", async () => {
  const expected = new Set<string>(),
    ids: string[] = [];
  for (const state of [
    "queued",
    "running",
    "settling",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ]) {
    for (const sealed of [false, true]) {
      for (const control of [
        null,
        "pending",
        "dispatched",
        "acknowledged",
        "completed",
        "failed",
      ]) {
        const id = randomUUID();
        ids.push(id);
        await sql`insert into runs values(${id}::uuid,${state},${sealed ? new Date() : null})`.execute(
          db,
        );
        if (control)
          await sql`insert into turn_control_requests values(${id}::uuid,${control})`.execute(db);
        if (
          ["completed", "failed", "cancelled", "timed_out"].includes(state) &&
          sealed &&
          (control === null || control === "completed" || control === "failed")
        )
          expected.add(id);
      }
    }
  }
  expect(await findRetiredRuns(db, ids)).toEqual(expected);
});

it("releases deleted authority rows and bounds each lookup without keeping stale result caches", async () => {
  const missing = Array.from({ length: 1001 }, () => randomUUID());
  expect(await findRetiredRuns(db, missing)).toEqual(new Set(missing));
  expect(await findRetiredRuns(db, [])).toEqual(new Set());
  const id = randomUUID();
  await sql`insert into runs values(${id}::uuid,'completed',null)`.execute(db);
  expect(await findRetiredRuns(db, [id])).toEqual(new Set());
});
