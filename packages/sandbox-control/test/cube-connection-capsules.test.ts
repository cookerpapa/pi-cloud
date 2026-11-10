import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CubePersistentCapsuleCodec } from "../src/cube-persistent-capsule.ts";
import { connectionFromCapsule, cubeConnectionResolver } from "../src/cube-connection-capsules.ts";

const key = new Uint8Array(32).fill(12),
  codec = new CubePersistentCapsuleCodec(key);
const target = {
  apiUrl: "http://cube.test",
  sandboxId: "aabbccddeeff00112233445566778899",
  nodeId: "node-1",
};
const instance = {
  ...target,
  templateId: "template",
  domain: "cube.test",
  metadata: {},
  state: "running",
  trafficAccessToken: "fixture-private-traffic-token",
};
const row = {
  id: "allocation",
  tenant_id: "tenant",
  workspace_id: "workspace",
  runtime_capsule: codec.seal({
    version: 2,
    instance,
    executionTarget: { ...target, bootId: "boot" },
    handle: {
      activationId: "allocation",
      runtimeName: target.sandboxId,
      assignment: { tenantId: "tenant", workspaceId: "workspace" },
    },
  }),
};
let pg: PGlite, socket: PGLiteSocketServer, db: Kysely<Database>;
beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await sql`create table workspace_runtimes(workspace_runtime_id text, tenant_id text, workspace_id text, runtime_capsule text, runtime_name text);
    create table development_environments(allocation_id text, tenant_id text, workspace_id text, runtime_capsule text, runtime_name text)`.execute(
    db,
  );
});
afterAll(async () => {
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

it("opens only the exact resource and provider connection recorded in the authenticated capsule", () => {
  expect(connectionFromCapsule(codec, row, target)).toEqual(instance);
  for (const changed of [{ tenant_id: "other" }, { workspace_id: "other" }, { id: "other" }])
    expect(connectionFromCapsule(codec, { ...row, ...changed }, target)).toBeUndefined();
  for (const changed of [
    { apiUrl: "http://other.test" },
    { nodeId: "node-2" },
    { sandboxId: "other" },
  ])
    expect(connectionFromCapsule(codec, row, { ...target, ...changed })).toBeUndefined();
  expect(() =>
    connectionFromCapsule(new CubePersistentCapsuleCodec(new Uint8Array(32)), row, target),
  ).toThrow("authentication failed");
});

it.each(["workspace_runtimes", "development_environments"] as const)(
  "cold lookup reads %s without creating or adopting a resource",
  async (table) => {
    await sql`insert into ${sql.table(table)} values(${row.id},${row.tenant_id},${row.workspace_id},${row.runtime_capsule},${target.sandboxId})`.execute(
      db,
    );
    try {
      const resolve = cubeConnectionResolver(db, key);
      expect(await resolve(target)).toEqual(instance);
      expect(await resolve({ ...target, apiUrl: "http://another-cluster.test" })).toBeUndefined();
    } finally {
      await sql`delete from ${sql.table(table)}`.execute(db);
    }
    expect(await cubeConnectionResolver(db, key)(target)).toBeUndefined();
  },
);
