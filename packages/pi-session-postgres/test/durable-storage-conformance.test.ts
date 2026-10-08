import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { sql, type Kysely } from "kysely";
import { PublishedDurableStorage } from "../src/durable/published-storage.ts";
import { DurablePostgresProjection } from "../src/durable/postgres-projection.ts";
import type { DurableBatch } from "../src/durable/types.ts";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { ImageAttachmentCodec, PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";

let database: Kysely<Database>, admin: Pool, name: string;
beforeAll(async () => {
  const url = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!url)
    throw new Error("Durable Storage requires real PostgreSQL; use the workspace test command");
  admin = new Pool({ connectionString: url, max: 1 });
  name = `durable_contract_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const endpoint = new URL(url);
  endpoint.pathname = `/${name}`;
  database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 4 });
  await runMigrations(database, "up");
}, 60_000);
afterAll(async () => {
  await database?.destroy();
  if (admin) {
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
});

async function fixture(
  options: {
    publish?: (
      batch: DurableBatch,
      projection: DurablePostgresProjection,
      inputConversations?: readonly number[],
    ) => Promise<void>;
    images?: ImageAttachmentCodec;
  } = {},
) {
  const tenantId = randomUUID(),
    sessionId = randomUUID();
  await database.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  await database
    .insertInto("pi_sessions")
    .values({
      tenant_id: tenantId,
      id: sessionId,
      created_at_ms: Date.now(),
      parent_session_id: null,
      name: null,
    })
    .execute();
  const projection = new DurablePostgresProjection(
    database,
    { tenantId, sessionId },
    options.images,
  );
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch, inputConversations) =>
      options.publish
        ? options.publish(batch, projection, inputConversations)
        : void (await projection.apply(batch)),
    waitProjected: async (through) => {
      if ((await projection.head()).seq < through)
        throw new Error("Fixture projection is still held");
    },
  });
  return {
    store,
    projection,
    tenantId,
    sessionId,
    async close() {
      await store.close(BACKGROUND_CONTEXT);
      await database.deleteFrom("pi_sessions").where("tenant_id", "=", tenantId).execute();
      await database.deleteFrom("tenants").where("id", "=", tenantId).execute();
    },
  };
}

for (const cold of [false, true])
  describe.sequential(
    `Pi Durable 1.0 real PG contract (${cold ? "cold indexed reads" : "acknowledged overlay"})`,
    () => {
      const cases = createStorageConformance({
        assertions: {
          ok: assert.ok,
          strictEqual: assert.strictEqual,
          deepEqual: assert.deepStrictEqual,
          partialDeepEqual: assert.partialDeepStrictEqual,
          greaterThan: (a, b) => assert(a > b),
          rejects: async (p, text) => {
            await assert.rejects(p, (e: Error) => e.message.includes(text));
          },
        },
        withStorage: async (use) => {
          const f = await fixture();
          const storage: Storage = cold
            ? new Proxy(f.store, {
                get(target, property) {
                  if (property === "commit")
                    return async (
                      writes: readonly StorageWrite[],
                      context: typeof BACKGROUND_CONTEXT,
                    ) => {
                      const seq = await target.commit(writes, context);
                      await target.flush();
                      return seq;
                    };
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              })
            : f.store;
          try {
            await use(storage);
          } finally {
            await f.close();
          }
        },
      });
      for (const contract of cases) it(contract.name, contract.run);
    },
  );

it("does not expose a projected but unacknowledged commit, then rejects uncertain ownership", async () => {
  const projected = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture({
    publish: async (batch, projection) => {
      await projection.apply(batch);
      if (++calls === 1) {
        projected.resolve();
        await release.promise;
      } else throw new Error("ACK lost after durable commit");
    },
  });
  try {
    const commit = f.store.commit(
      [{ type: "conversation", value: { id: 1 as never } }],
      BACKGROUND_CONTEXT,
    );
    await projected.promise;
    let visible = false;
    const reading = f.store.conversation(1 as never, BACKGROUND_CONTEXT).then((r) => {
      visible = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visible).toBe(false);
    release.resolve();
    await commit;
    expect(await reading).toEqual({ id: 1 });
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("ACK lost");
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("uncertain publication");
    expect((await f.projection.head()).seq).toBe(2);
    const reopened = await PublishedDurableStorage.open({
      projection: f.projection,
      publish: async (batch) => {
        await f.projection.apply(batch);
      },
      waitProjected: async () => {},
    });
    expect(await reopened.conversation(1 as never, BACKGROUND_CONTEXT)).toEqual({ id: 1 });
    expect(await reopened.commit([], BACKGROUND_CONTEXT)).toBe(3);
    await reopened.close(BACKGROUND_CONTEXT);
  } finally {
    release.resolve();
    await f.close();
  }
});

it("keeps proved refusal usable and rejects conflicting projection bytes atomically", async () => {
  let reject = true;
  let saved: DurableBatch | undefined;
  const f = await fixture({
    publish: async (batch, projection) => {
      if (reject) {
        reject = false;
        throw new PublicationNotSentError("not admitted");
      }
      saved = batch;
      await projection.apply(batch);
    },
  });
  try {
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("not admitted");
    expect(await f.projection.head()).toEqual({ seq: 0, nextId: 2 });
    await f.store.commit([{ type: "conversation", value: { id: 1 as never } }], BACKGROUND_CONTEXT);
    expect(await f.projection.apply(saved!)).toBe(false);
    await expect(f.projection.apply({ ...saved!, writes: [] })).rejects.toThrow("changed bytes");
    expect(await f.store.conversation(1 as never, BACKGROUND_CONTEXT)).toEqual({ id: 1 });
  } finally {
    await f.close();
  }
});

it("batches document revision metadata without per-document reads and keeps fixed selector keys literal", async () => {
  const queries: string[] = [];
  const measured = database.withPlugin({
    transformQuery({ node, queryId }) {
      queries.push(database.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const f = await fixture({
    publish: async (batch, projection) => {
      await new DurablePostgresProjection(measured, projection.scope).apply(batch);
    },
  });
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 } },
        ...Array.from({ length: 16 }, (_, i) => ({
          type: "document.create",
          record: {
            id: i + 2,
            kind: `fixture-${i}`,
            scope: { kind: "conversation", conversationId: 1 },
            history: "latest",
            fork: "current",
          },
          content: { kind: "base", version: 1, value: { text: "before" } },
        })),
      ] as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    queries.length = 0;
    await f.store.commit(
      Array.from({ length: 16 }, (_, i) => ({
        type: "document.change",
        id: i + 2,
        content: { kind: "delta", version: 1, ops: [["s", ["text"], "after"]] },
      })) as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    expect(queries.filter((query) => /^select/i.test(query.trim())).length).toBe(3);
    expect(
      queries.filter((query) => query.startsWith("insert into pi_durable_document_revisions")),
    ).toHaveLength(1);
    queries.length = 0;
    await new DurablePostgresProjection(measured, f.projection.scope).scan(
      { kind: "entry", fields: { conversation: "1" } },
      1,
    );
    expect(queries[0]).toContain("r.fields->>'conversation'");
    expect(
      await f.store.document(
        2 as import("@earendil-works/pi-durable").DocumentId,
        "current",
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ value: { text: "after" } });
  } finally {
    await f.store.close(BACKGROUND_CONTEXT);
  }
});

it("keeps long native document tails bounded after cold reopen without changing native delta counts", async () => {
  const f = await fixture();
  try {
    const id = await f.store.mintId<import("@earendil-works/pi-durable").DocumentId>();
    await f.store.commit(
      [
        {
          type: "document.create",
          record: { id, kind: "cold", scope: { kind: "session" } },
          content: { kind: "base", version: 1, value: { count: 0 } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    for (let n = 1; n <= 130; n++) {
      await f.store.commit(
        [
          {
            type: "document.change",
            id,
            content: { kind: "delta", version: 1, ops: [["s", ["count"], n]] },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      if (n === 70) await f.store.flush();
    }
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { count: 130 },
      deltasSinceBase: 130,
    });
    expect(
      (await f.projection.revisions(id, f.store.committedSequence)).length,
    ).toBeLessThanOrEqual(64);
    await f.store.flush();
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { count: 130 },
      deltasSinceBase: 130,
    });
    const counts = await sql<{ bodies: string }>`select count(*) as bodies from pi_durable_log
      where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId}`.execute(database);
    expect(Number(counts.rows[0]!.bodies)).toBe(131);
  } finally {
    await f.close();
  }
});

it("reads a complete acknowledged base locally but still loads missing historical bases after eviction", async () => {
  const pending: DurableBatch[] = [];
  const f = await fixture({
    publish: async (batch) => {
      pending.push(batch);
    },
  });
  const read = vi.spyOn(f.projection, "revisions");
  try {
    const conversationId =
      await f.store.mintId<import("@earendil-works/pi-durable").ConversationId>();
    const id = await f.store.mintId<import("@earendil-works/pi-durable").DocumentId>();
    const created = await f.store.commit(
      [
        { type: "conversation", value: { id: conversationId } },
        {
          type: "document.create",
          record: {
            id,
            kind: "overlay",
            scope: { kind: "conversation", conversationId },
            history: "rewindable",
            fork: "asOf",
          },
          content: { kind: "base", version: 1, value: { count: 0 } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    read.mockRejectedValue(new Error("projection unavailable"));
    for (let count = 1; count <= 130; count++) {
      await f.store.commit(
        [
          {
            type: "document.change",
            id,
            content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
        value: { count },
        version: 1,
        deltasSinceBase: count,
      });
    }
    expect(await f.store.document(id, created, BACKGROUND_CONTEXT)).toMatchObject({
      value: { count: 0 },
      deltasSinceBase: 0,
    });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    for (const batch of pending.splice(0)) await f.projection.apply(batch);
    await f.store.flush();
    const cold = vi.spyOn(f.projection, "revisions");
    await f.store.commit(
      [
        {
          type: "document.change",
          id,
          content: { kind: "delta", version: 1, ops: [["s", ["count"], 131]] },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { count: 131 },
      deltasSinceBase: 131,
    });
    expect(cold).toHaveBeenCalledOnce();
    cold.mockClear();
    const newBase = await f.store.commit(
      [
        {
          type: "document.change",
          id,
          content: { kind: "base", version: 2, value: { changed: true } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    expect(await f.store.document(id, newBase, BACKGROUND_CONTEXT)).toMatchObject({
      version: 2,
      value: { changed: true },
      deltasSinceBase: 0,
    });
    expect(cold).not.toHaveBeenCalled();
    expect(await f.store.document(id, created, BACKGROUND_CONTEXT)).toMatchObject({
      version: 1,
      value: { count: 0 },
      deltasSinceBase: 0,
    });
    expect(cold).toHaveBeenCalledOnce();
    cold.mockRestore();
  } finally {
    read.mockRestore();
    await f.close();
  }
});

it("retains acknowledged batches while projection is paused and reads only the requested cold suffix", async () => {
  const pending: DurableBatch[] = [];
  const f = await fixture({
    publish: async (batch) => {
      pending.push(batch);
    },
  });
  try {
    await f.store.commit([{ type: "conversation", value: { id: 1 as never } }], BACKGROUND_CONTEXT);
    await f.store.commit(
      Array.from({ length: 1000 }, (_, i): StorageWrite => ({
        type: "entry",
        value: {
          id: (i + 2) as never,
          conversationId: 1 as never,
          kind: "message",
          data: { text: "x".repeat(1000) },
          ...(i === 990 ? { head: (i + 2) as never } : {}),
        },
      })),
      BACKGROUND_CONTEXT,
    );
    expect((await f.projection.head()).seq).toBe(0);
    expect(
      (await f.store.scanEntries({ conversationId: 1 as never }, 2, undefined, BACKGROUND_CONTEXT))
        .items,
    ).toHaveLength(2);
    for (const batch of pending) await f.projection.apply(batch);
    await f.store.flush();
    const reopened = await PublishedDurableStorage.open({
      projection: f.projection,
      publish: async () => {
        throw new Error("read fixture");
      },
      waitProjected: async () => {},
    });
    const marker = await reopened.findLatestHeadMarker(1 as never, undefined, BACKGROUND_CONTEXT);
    expect(marker?.head).toBe(992);
    expect(
      (
        await reopened.scanEntries(
          { conversationId: 1 as never, minEntryId: marker!.head },
          32,
          undefined,
          BACKGROUND_CONTEXT,
        )
      ).items,
    ).toHaveLength(10);
    await reopened.close(BACKGROUND_CONTEXT);
  } finally {
    await f.close();
  }
});

it("validates warm native writes without per-commit PostgreSQL reads", async () => {
  const f = await fixture();
  try {
    const id = await f.store.mintId<import("@earendil-works/pi-durable").DocumentId>();
    await f.store.commit(
      [
        {
          type: "document.create",
          record: { id, kind: "warm", scope: { kind: "session" } },
          content: { kind: "base", version: 1, value: { count: 0 } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    await f.store.commit(
      [
        {
          type: "document.change",
          id,
          content: { kind: "delta", version: 1, ops: [["s", ["count"], 1]] },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    const gets = vi.spyOn(f.projection, "get"),
      scans = vi.spyOn(f.projection, "scan"),
      revisions = vi.spyOn(f.projection, "latestRevision");
    for (let n = 2; n < 12; n++) {
      const taskId =
        await f.store.mintId<
          import("@earendil-works/pi-durable").TaskId<import("@earendil-works/chord").JsonValue>
        >();
      const docId = await f.store.mintId<import("@earendil-works/pi-durable").DocumentId>();
      await f.store.commit(
        [
          {
            type: "task",
            value: {
              id: taskId,
              conversationId: 1 as never,
              kind: "test",
              version: 1,
              input: null,
              background: false,
              abortRequested: false,
              state: { status: "pending", checkpoint: { phase: "start" } },
            },
          },
          {
            type: "document.create",
            record: { id: docId, kind: "task.data", scope: { kind: "task", taskId } },
            content: { kind: "base", version: 1, value: {} },
          },
          {
            type: "document.change",
            id,
            content: { kind: "delta", version: 1, ops: [["s", ["count"], n]] },
          },
        ],
        BACKGROUND_CONTEXT,
      );
    }
    expect(gets).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
    expect(revisions).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("externalizes every image in real Harness submissions, Tool results and copied documents", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII=";
  const image = { type: "image" as const, data, mimeType: "image/png" };
  const objects = new Map<string, Buffer>();
  const attachmentStore = new PostgresImageAttachmentStore(database, {
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async *readStream(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Object missing");
      yield bytes;
    },
    async delete(key) {
      objects.delete(key);
    },
  });
  const codec = new ImageAttachmentCodec(attachmentStore);
  let imageBatches = 0;
  const f = await fixture({
    images: codec,
    publish: async (batch, projection) => {
      const scope = { tenantId: projection.scope.tenantId };
      if (JSON.stringify(batch).includes(data)) imageBatches++;
      const packed = await codec.pack(scope, batch);
      expect(JSON.stringify(packed)).not.toContain(data);
      const native = await codec.unpack<DurableBatch>(scope, packed);
      expect(native).toEqual(batch);
      await projection.apply(packed);
    },
  });
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  const entered = Promise.withResolvers<void>(),
    finishTool = Promise.withResolvers<void>();
  try {
    const models = createModels(),
      faux = fauxProvider({
        tokensPerSecond: 1_000_000,
        models: [{ id: "vision", input: ["text", "image"] }],
      });
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "images",
        tools: [
          defineTool({
            name: "picture",
            description: "Return a test image",
            parameters: Type.Object({}),
            execute: async () => {
              entered.resolve();
              await finishTool.promise;
              return { content: [image] };
            },
          }),
        ],
      }),
    );
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("picture", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Seen"),
      fauxAssistantMessage("Remembered"),
    ]);
    harness = await Harness.open(
      f.store,
      { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT,
    );
    const model = faux.getModel();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const first = await root.submit(
      { type: "input", content: [{ type: "text", text: "Inspect" }, image], requestId: "first" },
      BACKGROUND_CONTEXT,
    );
    await entered.promise;
    const second = await root.submit(
      {
        type: "input",
        content: [{ type: "text", text: "Remember the image" }, image],
        requestId: "second",
        whenBusy: "followUp",
      },
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    finishTool.resolve();
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const settled = await second.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("done");
    const context = await root.context(BACKGROUND_CONTEXT);
    expect(JSON.stringify(context.messages)).toContain(data);
    expect(imageBatches).toBeGreaterThan(2);
    const bodies = await sql<{ body: string }>`select body from pi_durable_log
      where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId}`.execute(database);
    expect(JSON.stringify(bodies.rows)).not.toContain(data);
    await sql`update session_image_objects set created_at=clock_timestamp()-interval '2 days'
      where tenant_id=${f.tenantId}::uuid`.execute(database);
    expect(await attachmentStore.reap(1000)).toBe(0);
    const reader = new DurablePostgresProjection(
      database,
      f.projection.scope,
      new ImageAttachmentCodec(attachmentStore),
    );
    const reopened = await PublishedDurableStorage.open({
      projection: reader,
      publish: async () => {
        throw new Error("read fixture");
      },
      waitProjected: async () => {},
    });
    const entries = await reopened.scanEntries(
      { conversationId: root.id },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(JSON.stringify(entries)).toContain(data);
    await reopened.close(BACKGROUND_CONTEXT);
    expect(faux.state.callCount).toBe(3);
    if (settled.type === "input" && settled.status === "done") {
      const child = await root.fork(
        settled.answer,
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      expect(JSON.stringify((await child.context(BACKGROUND_CONTEXT)).messages)).toContain(data);
    }
  } finally {
    finishTool.resolve();
    await harness?.close(BACKGROUND_CONTEXT);
    await f.close();
    while (await attachmentStore.reap(1000)) {
      /* All objects in this isolated database are fixture-owned. */
    }
    expect(objects.size).toBe(0);
  }
});

it("reads a fresh native head after waiting for the physical Session projection lock", async () => {
  const f = await fixture(),
    locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const first = {
    seq: 1,
    nextId: 2,
    writes: [{ type: "conversation", value: { id: 1 } }],
  } as unknown as DurableBatch;
  const second = {
    seq: 2,
    nextId: 3,
    writes: [{ type: "entry", value: { id: 2, conversationId: 1, kind: "test", data: "second" } }],
  } as unknown as DurableBatch;
  const holding = database.transaction().execute(async (tx) => {
    await sql`select id from pi_sessions where tenant_id=${f.tenantId}::uuid and id=${f.sessionId} for update`.execute(
      tx,
    );
    locked.resolve();
    await release.promise;
    await f.projection.applyIn(tx, first);
  });
  await locked.promise;
  let completed = false;
  const waiting = f.projection.apply(second).then((result) => {
    completed = true;
    return result;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    release.resolve();
    await holding;
    expect(await waiting).toBe(true);
    expect((await f.projection.head()).seq).toBe(2);
  } finally {
    release.resolve();
    await Promise.allSettled([holding, waiting]);
    await f.close();
  }
});

it("keeps task and result origins when cleanup runs under a later admitted Turn", async () => {
  const f = await fixture();
  const original = {
    recordId: 2,
    sessionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
  };
  const next = { ...original, runId: randomUUID(), turnId: randomUUID() };
  const task = {
    id: 2,
    conversationId: 1,
    kind: "pi.generation",
    version: 1,
    input: {},
    background: false,
    abortRequested: false,
    state: { status: "pending", checkpoint: { phase: "prepare", attempt: 1 } },
  };
  try {
    await f.projection.apply(
      {
        seq: 1,
        nextId: 3,
        writes: [
          { type: "conversation", value: { id: 1 } },
          { type: "task", value: task },
        ],
      } as unknown as DurableBatch,
      [original],
    );
    await f.projection.apply(
      {
        seq: 2,
        nextId: 4,
        writes: [
          {
            type: "task",
            value: {
              ...task,
              abortRequested: true,
              state: { status: "terminal", outcome: { status: "aborted" } },
            },
          },
          {
            type: "entry",
            value: { id: 3, conversationId: 1, byTaskId: 2, kind: "test.result", data: "cleanup" },
          },
        ],
      } as unknown as DurableBatch,
      [next, { ...next, recordId: 3 }],
    );
    for (const id of [2, 3])
      expect((await f.projection.get(id))?.fields).toMatchObject({
        run: original.runId,
        turn: original.turnId,
        cloudSession: original.sessionId,
      });
  } finally {
    await f.close();
  }
});

it("retains a conservative Run budget floor across duplicate checkpoint and abort writes", async () => {
  const { readDurableRunUsage } = await import("../src/durable/run-usage.ts");
  const f = await fixture(),
    runId = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const generation = {
    id: 2,
    conversationId: 1,
    kind: "pi.generation",
    version: 1,
    input: {},
    background: false,
    abortRequested: false,
    state: { status: "running", checkpoint: { phase: "request", attempt: 1, cutoff: 1 } },
  };
  const tool = {
    ...generation,
    id: 3,
    kind: "pi.tool",
    state: { status: "running", checkpoint: { phase: "execute", arguments: {}, replay: "unsafe" } },
  };
  const origins = [2, 3].map((recordId) => ({ recordId, sessionId: f.sessionId, runId, turnId }));
  try {
    await f.projection.apply(
      {
        seq: 1,
        nextId: 4,
        writes: [
          { type: "conversation", value: { id: 1 } },
          { type: "task", value: generation },
          { type: "task", value: tool },
        ],
      } as unknown as DurableBatch,
      origins,
    );
    await f.projection.apply(
      {
        seq: 2,
        nextId: 4,
        writes: [
          { type: "task", value: { ...generation, abortRequested: true } },
          { type: "task", value: { ...tool, abortRequested: true } },
        ],
      } as unknown as DurableBatch,
      origins,
    );
    expect(await readDurableRunUsage(database, f.tenantId, runId)).toEqual({
      modelRequests: 1,
      toolCalls: 1,
    });
    expect(await readDurableRunUsage(database, crypto.randomUUID(), runId)).toEqual({
      modelRequests: 0,
      toolCalls: 0,
    });
    await f.projection.apply(
      {
        seq: 3,
        nextId: 4,
        writes: [
          {
            type: "task",
            value: {
              ...generation,
              state: { status: "running", checkpoint: { phase: "request", attempt: 2, cutoff: 1 } },
            },
          },
        ],
      } as unknown as DurableBatch,
      origins,
    );
    expect(await readDurableRunUsage(database, f.tenantId, runId)).toEqual({
      modelRequests: 2,
      toolCalls: 1,
    });
  } finally {
    await f.close();
  }
});

it("carries queue wakes on the native commit only for changed queue documents", async () => {
  const observed: Array<readonly number[]> = [];
  const f = await fixture({
    publish: async (batch, projection, conversations) => {
      observed.push(conversations ?? []);
      await projection.apply(batch);
    },
  });
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 } },
        ...["pi.inbox", "pi-cloud.human-inputs", "test.other"].map((kind, index) => ({
          type: "document.create",
          record: {
            id: index + 2,
            kind,
            scope: { kind: "conversation", conversationId: 1 },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: { count: 0 } },
        })),
      ] as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    await f.store.commit(
      [
        {
          type: "document.change",
          id: 4,
          content: { kind: "delta", version: 1, ops: [["s", ["count"], 1]] },
        },
      ] as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    await f.store.commit(
      [
        {
          type: "document.change",
          id: 2,
          content: { kind: "delta", version: 1, ops: [["s", ["count"], 1]] },
        },
      ] as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    expect(observed).toEqual([[1], [], [1]]);
  } finally {
    await f.close();
  }
});
