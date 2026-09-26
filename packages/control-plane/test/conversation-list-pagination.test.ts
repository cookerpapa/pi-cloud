import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

let pg: PGlite, socket: PGLiteSocketServer, db: Kysely<Database>;
beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(db, "up");
}, 30000);
afterAll(async () => {
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

it("pages beyond 100 owned Sessions without losing PostgreSQL microseconds or tenant scope", async () => {
  const owner = await createPrivateTenant(db, { slug: "paged-owner", ownerDisplayName: "Owner" });
  const store = new ControlPlaneStore({ database: db, ...owner });
  const project = await store.createProject({ name: "fixture", source: { kind: "empty" } });
  const ids: string[] = [];
  for (let i = 0; i < 103; i++)
    ids.push(
      (await store.createSession(project.projectId, project.workspaceId, `session-${i}`, "elastic"))
        .sessionId,
    );
  await sql`update sessions s set last_active_at='2026-09-26T00:00:00Z'::timestamptz + p.n * interval '1 microsecond'
    from jsonb_to_recordset(${JSON.stringify(ids.map((id, n) => ({ id, n: n + 1 })))}::jsonb) p(id text,n integer)
    where s.id=p.id::uuid`.execute(db);
  const first = await store.listConversations();
  expect(first.conversations).toHaveLength(100);
  expect(first.nextCursor).toBeDefined();
  expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).at).toBe(
    "2026-09-26T00:00:00.000004Z",
  );
  const second = await store.listConversations(first.nextCursor);
  expect(second.conversations).toHaveLength(3);
  expect(second.nextCursor).toBeUndefined();
  expect(
    new Set([...first.conversations, ...second.conversations].map((row) => row.sessionId)),
  ).toEqual(new Set(ids));
  const outsider = await createPrivateTenant(db, {
    slug: "paged-outsider",
    ownerDisplayName: "Outsider",
  });
  expect(
    (await new ControlPlaneStore({ database: db, ...outsider }).listConversations(first.nextCursor))
      .conversations,
  ).toEqual([]);
  for (const cursor of [
    "!",
    "e30",
    Buffer.from(JSON.stringify({ at: "invalid", id: ids[0] })).toString("base64url"),
    Buffer.from(JSON.stringify({ at: "2026-02-31T00:00:00.000000Z", id: ids[0] })).toString(
      "base64url",
    ),
  ])
    await expect(store.listConversations(cursor)).rejects.toMatchObject({
      code: "invalid_request",
    });
}, 30000);
