import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { beforeAll, afterAll, expect, it } from "vitest";
import { PostgresPiSessionStorage } from "../src/postgres-session-storage.ts";
import { NativeSessionWriter } from "../src/native-session-writer.ts";
import { projectNativeSessionAppend } from "../src/project-native-session-append.ts";
import type { PiCommittedItem } from "../src/session-mutation.ts";

let pg: PGlite, socket: PGLiteSocketServer, db: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(db, "up");
}, 30_000);
afterAll(async () => {
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

async function fixture() {
  const tenantId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  await db.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  const storage = await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
  const frames: { appendId: string; items: PiCommittedItem[] }[] = [];
  const publisher = {
    publish: async (input: readonly PiCommittedItem[]) => {
      const items = structuredClone([...input]).map((item) =>
        item.kind === "entry" || item.kind === "record" ? { ...item, turnId: null } : item,
      );
      frames.push({ appendId: crypto.randomUUID(), items });
    },
  };
  const writer = new NativeSessionWriter({
    id: crypto.randomUUID(),
    metadata: await storage.getMetadata(),
    nextSequence: 1,
    lanes: await storage.getLanes(),
    hasId: async () => false,
    waitProjected: async () => {
      throw new Error("projection paused");
    },
    fail: async () => {},
  });
  const main = await writer.open(
    { lane: "main", turnId: "test", attemptId: "test" },
    { branch: [], openOperations: [], reader: storage },
    publisher,
  );
  const project = (frame: (typeof frames)[number], target = db) =>
    target
      .transaction()
      .execute((tx) => projectNativeSessionAppend(tx, { tenantId, sessionId, ...frame }));
  return { tenantId, sessionId, storage, frames, writer, main, publisher, project };
}

it("projects exact writer stamps, mixed records and inherited/empty Lanes after delayed projection", async () => {
  const f = await fixture();
  const root = await f.main.appendEntry(
    { id: f.writer.idGenerator(), type: "custom", customType: "state", data: "original" },
    "main",
  );
  await f.main.createLane("branch", root.id);
  await f.main.createLane("fresh", null);
  const child = await f.writer.open(
    { lane: "branch", turnId: "child", attemptId: "child" },
    { branch: [], openOperations: [], reader: f.storage },
    f.publisher,
  );
  const operation = f.writer.idGenerator();
  await child.mutate({
    kind: "append_items",
    items: [
      {
        kind: "append_record",
        record: {
          id: operation,
          lane: "branch",
          type: "operation_started",
          sourceLeafId: root.id,
          intent: { kind: "run", originalPrompt: [], initialMessages: [] },
        },
      },
      {
        kind: "append_entry",
        lane: "branch",
        entry: {
          id: f.writer.idGenerator(),
          type: "custom",
          customType: "child",
          data: "not in PG yet",
        },
      },
    ],
  });
  const summary = await child.appendEntry(
    {
      id: f.writer.idGenerator(),
      type: "compaction",
      summary: "bounded",
      retainedTail: [],
      tokensBefore: 100,
    },
    "branch",
  );
  await child.appendRecord({
    id: f.writer.idGenerator(),
    type: "operation_finished",
    lane: "branch",
    runId: operation,
    outcome: "completed",
  });
  await f.main.setName("durable");
  await f.main.setLabel(root.id, "anchor");
  expect(await f.storage.getLog()).toHaveLength(0);
  for (const frame of f.frames) await f.project(frame);
  expect(await f.storage.getEntry(root.id)).toEqual(root);
  expect(await f.storage.getEntry(summary.id)).toEqual(summary);
  expect(await f.storage.getLanes()).toEqual([
    { lane: "branch", leafId: summary.id },
    { lane: "fresh", leafId: null },
    { lane: "main", leafId: root.id },
  ]);
  expect(await f.storage.findOpenOperations("branch")).toEqual([]);
  expect(await f.storage.getName()).toBe("durable");
  expect(await f.storage.getLabel(root.id)).toBe("anchor");
  const before = await f.storage.getLog();
  for (const frame of f.frames) await f.project(frame);
  expect(await f.storage.getLog()).toEqual(before);
  expect(
    (await db.introspection.getTables()).some((t) => t.name === "pi_session_mutation_results"),
  ).toBe(false);
});

it("rolls back Entries, Lane heads and sequence when log insertion fails", async () => {
  const f = await fixture();
  const entry = await f.main.appendEntry(
    { id: f.writer.idGenerator(), type: "custom", customType: "state", data: "atomic" },
    "main",
  );
  const failing = db.withPlugin({
    transformQuery({ node }) {
      if (node.kind === "InsertQueryNode" && JSON.stringify(node.into).includes('"pi_session_log"'))
        throw new Error("log unavailable");
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  await expect(f.project(f.frames[0]!, failing)).rejects.toThrow("log unavailable");
  expect(await f.storage.getEntry(entry.id)).toBeUndefined();
  expect(await f.storage.getLanes()).toEqual([{ lane: "main", leafId: null }]);
  await f.project(f.frames[0]!);
  expect(await f.storage.getEntry(entry.id)).toEqual(entry);
});

it("rejects sequence holes, conflicting parents and Entry/Record ID reuse without partial effects", async () => {
  const f = await fixture();
  const first = await f.main.appendEntry(
    { id: f.writer.idGenerator(), type: "custom", customType: "state" },
    "main",
  );
  await f.project(f.frames[0]!);
  const bad = (items: PiCommittedItem[]) => f.project({ appendId: crypto.randomUUID(), items });
  await expect(
    bad([
      {
        kind: "entry",
        lane: "main",
        turnId: null,
        entry: { ...first, id: "gap", seq: 3, parentId: first.id },
      },
    ]),
  ).rejects.toThrow("not contiguous");
  await expect(
    bad([
      {
        kind: "entry",
        lane: "main",
        turnId: null,
        entry: { ...first, id: "wrong-parent", seq: 2, parentId: null },
      },
    ]),
  ).rejects.toThrow("parent differs");
  await expect(
    bad([
      {
        kind: "record",
        turnId: null,
        record: {
          id: first.id,
          seq: 2,
          timestamp: 1,
          lane: "main",
          type: "abort_requested",
          runId: "run",
        },
      },
    ]),
  ).rejects.toThrow("reuses an ID");
  expect(await f.storage.getLog()).toHaveLength(1);
  const next = await f.main.appendEntry(
    { id: f.writer.idGenerator(), type: "custom", customType: "state" },
    "main",
  );
  await f.project(f.frames[1]!);
  expect(await f.storage.getEntry(next.id)).toEqual(next);
});
