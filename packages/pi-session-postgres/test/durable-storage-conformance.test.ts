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
        : void (await projection.apply(batch, [], {
            topic: "native-fixture",
            partition: 0,
            offset: BigInt(batch.seq),
          })),
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

it("retains cloud dispatch references with the native commit and rejects changed replay metadata", async () => {
  let saved: DurableBatch | undefined;
  const metadata = {
    controlTools: [
      { operationId: randomUUID(), taskId: 4, conversationId: 1, toolName: "subagent" },
    ],
  };
  const f = await fixture({
    publish: async (batch, projection) => {
      saved = batch;
      await projection.apply(batch, [], undefined, metadata);
    },
  });
  try {
    await f.store.commit([{ type: "conversation", value: { id: 1 as never } }], BACKGROUND_CONTEXT);
    const row = await sql<{ cloud_metadata: string }>`select cloud_metadata from pi_durable_commits
      where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId} and seq=${saved!.seq}`.execute(
      database,
    );
    expect(JSON.parse(row.rows[0]!.cloud_metadata)).toEqual(metadata);
    await expect(f.projection.apply(saved!, [], undefined, metadata)).resolves.toBe(false);
    await expect(
      f.projection.apply(saved!, [], undefined, {
        controlTools: [{ ...metadata.controlTools[0], operationId: randomUUID() }],
      }),
    ).rejects.toThrow("changed bytes");
    await expect(f.projection.apply(saved!)).rejects.toThrow("changed bytes");
    expect((await f.projection.head()).seq).toBe(saved!.seq);
    await f.projection.rebuild();
    const retained = await sql<{
      cloud_metadata: string;
    }>`select cloud_metadata from pi_durable_commits
      where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId} and seq=${saved!.seq}`.execute(
      database,
    );
    expect(retained.rows).toEqual(row.rows);
  } finally {
    await f.close();
  }
});

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

it("keeps native live progress out of PG while preserving current reads across flush", async () => {
  const f = await fixture();
  const id = 2 as import("@earendil-works/pi-durable").DocumentId;
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "document.create",
          record: {
            id,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: 1 as never },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
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
            content: {
              kind: "delta",
              version: 1,
              ops: [
                [
                  "s",
                  ["generation"],
                  { attempt: 1, message: { text: `LIVE_ONLY_${n}\u0000\ud800` } },
                ],
              ],
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      if (n % 19 === 0) await f.store.flush();
    }
    await f.store.flush();
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { generation: { message: { text: "LIVE_ONLY_130\u0000\ud800" } } },
      deltasSinceBase: 130,
    });
    const payloads = await sql<{
      body: string;
    }>`select body from pi_durable_log where tenant_id=${f.tenantId}::uuid
      union all select body from pi_durable_current where tenant_id=${f.tenantId}::uuid`.execute(
      database,
    );
    expect(payloads.rows.some((r) => r.body.includes("LIVE_ONLY_"))).toBe(false);
    expect(
      (
        await sql`select 1 from pi_durable_document_revisions where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    await f.store.commit(
      [{ type: "document.change", id, content: { kind: "base", version: 1, value: {} } }],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: {},
      deltasSinceBase: 0,
    });
    await f.projection.rebuild();
  } finally {
    await f.close();
  }
});

it("replays accepted live state after owner loss and makes one exact handoff checkpoint", async () => {
  const batches: DurableBatch[] = [];
  const position = (batch: DurableBatch) => ({
    topic: "live-recovery",
    partition: 2,
    offset: (1n << 54n) + BigInt(batch.seq) * 10n,
  });
  const f = await fixture({
    publish: async (batch, projection) => {
      batches.push(structuredClone(batch));
      await projection.apply(batch, [], position(batch));
    },
  });
  const id = 2 as import("@earendil-works/pi-durable").DocumentId;
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "document.create",
          record: {
            id,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: 1 as never },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    for (let n = 1; n <= 4; n++)
      await f.store.commit(
        [
          {
            type: "document.change",
            id,
            content: {
              kind: "delta",
              version: 1,
              ops: [
                [
                  "s",
                  ["generation"],
                  { attempt: 1, message: { text: `recover-${n}\u0000\ud800` } },
                ],
              ],
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
    await expect(
      PublishedDurableStorage.open({
        projection: f.projection,
        publish: async () => {},
        waitProjected: async () => {},
      }),
    ).rejects.toThrow("ordered Kafka recovery");
    await expect(f.projection.revisions(id, 5)).rejects.toThrow("Kafka replay");
    await expect(f.projection.rebuild()).rejects.toThrow("Kafka recovery");
    const fresh = new DurablePostgresProjection(database, f.projection.scope);
    await expect(fresh.apply(batches[2]!, [], position(batches[2]!))).rejects.toThrow(
      "sequence gap",
    );
    for (const batch of batches) expect(await fresh.apply(batch, [], position(batch))).toBe(false);
    const before = await fresh.head();
    expect(await fresh.apply(batches[2]!, [], position(batches[2]!))).toBe(false);
    const checkpoint = fresh.liveState.fork();
    await expect(
      database.transaction().execute(async (tx) => {
        await fresh.checkpointLiveIn(tx, checkpoint);
        throw new Error("rollback handoff");
      }),
    ).rejects.toThrow("rollback handoff");
    await expect(fresh.assertComplete()).rejects.toThrow("Kafka recovery");
    await database
      .transaction()
      .execute((tx) => fresh.checkpointLiveIn(tx, fresh.liveState.fork()));
    expect(await fresh.head()).toEqual(before);
    await fresh.rebuild();
    const cold = await PublishedDurableStorage.open({
      projection: fresh,
      publish: async () => {},
      waitProjected: async () => {},
    });
    expect(await cold.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { generation: { message: { text: "recover-4\u0000\ud800" } } },
      deltasSinceBase: 4,
    });
    await cold.close(BACKGROUND_CONTEXT);
    const changed = { ...structuredClone(batches[2]!), nextId: batches[2]!.nextId + 1 };
    await expect(fresh.apply(changed, [], position(changed))).rejects.toThrow("changed bytes");
    await sql`update pi_durable_current set delta_count=99 where tenant_id=${f.tenantId}::uuid and id=2`.execute(
      database,
    );
    await expect(fresh.revisions(id, before.seq)).rejects.toThrow("integrity");
  } finally {
    await f.close();
  }
});

it("does not adopt live projection memory or a recovery reference after SQL rollback", async () => {
  const f = await fixture();
  const id = 2 as import("@earendil-works/pi-durable").DocumentId;
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "document.create",
          record: {
            id,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: 1 as never },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    const write: StorageWrite = {
      type: "document.change",
      id,
      content: {
        kind: "delta",
        version: 1,
        ops: [["s", ["generation"], { attempt: 1, message: { text: "rolled back" } }]],
      },
    };
    const batch = { seq: 2 as never, nextId: 3, writes: [write] };
    const state = f.projection.liveState.fork();
    await expect(
      database.transaction().execute(async (tx) => {
        await f.projection.applyIn(tx, batch, [], {
          state,
          position: { topic: "native-fixture", partition: 0, offset: 2n },
        });
        throw new Error("rollback mixed commit");
      }),
    ).rejects.toThrow("rollback mixed commit");
    expect((await f.projection.head()).seq).toBe(1);
    expect(f.projection.liveState.rows.size).toBe(0);
    await f.projection.assertComplete();
    await f.store.commit([write], BACKGROUND_CONTEXT);
    expect(f.projection.liveState.rows.size).toBe(1);
    await expect(f.projection.assertComplete()).rejects.toThrow("Kafka recovery");
  } finally {
    await f.close();
  }
});

it("recovers an accepted live update after a lost publication acknowledgement", async () => {
  const batches: DurableBatch[] = [];
  const at = (batch: DurableBatch) => ({
    topic: "lost-live-ack",
    partition: 0,
    offset: BigInt(batch.seq),
  });
  const f = await fixture({
    publish: async (batch, projection) => {
      batches.push(structuredClone(batch));
      await projection.apply(batch, [], at(batch));
      if (batch.seq === 2) throw new Error("lost live acknowledgement");
    },
  });
  const id = 2 as import("@earendil-works/pi-durable").DocumentId;
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "document.create",
          record: {
            id,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: 1 as never },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await expect(
      f.store.commit(
        [
          {
            type: "document.change",
            id,
            content: {
              kind: "delta",
              version: 1,
              ops: [
                [
                  "s",
                  ["generation"],
                  { attempt: 1, message: { text: "committed despite missing ACK" } },
                ],
              ],
            },
          },
        ],
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("lost live acknowledgement");
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("uncertain publication");
    const fresh = new DurablePostgresProjection(database, f.projection.scope);
    for (const batch of batches) await fresh.apply(batch, [], at(batch));
    await database
      .transaction()
      .execute((tx) => fresh.checkpointLiveIn(tx, fresh.liveState.fork()));
    const cold = await PublishedDurableStorage.open({
      projection: fresh,
      publish: async () => {},
      waitProjected: async () => {},
    });
    expect(await cold.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { generation: { message: { text: "committed despite missing ACK" } } },
    });
    await cold.close(BACKGROUND_CONTEXT);
  } finally {
    await f.close();
  }
});

it("replays interleaved Conversations after one live document has already settled", async () => {
  const batches: DurableBatch[] = [];
  const at = (batch: DurableBatch) => ({
    topic: "shared-native-writer",
    partition: 1,
    offset: BigInt(batch.seq) * 10n,
  });
  const f = await fixture({
    publish: async (batch, projection) => {
      batches.push(structuredClone(batch));
      await projection.apply(batch, [], at(batch));
    },
  });
  const a = 10 as import("@earendil-works/pi-durable").DocumentId;
  const b = 11 as import("@earendil-works/pi-durable").DocumentId;
  const answer = fauxAssistantMessage("A ready");
  const update = (id: typeof a, text: string): StorageWrite => ({
    type: "document.change",
    id,
    content: {
      kind: "delta",
      version: 1,
      ops: [["s", ["generation"], { attempt: 1, message: { text } }]],
    },
  });
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        { type: "conversation", value: { id: 2 as never } },
        ...[a, b].map((id, index) => ({
          type: "document.create",
          record: {
            id,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: index + 1 },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
        })),
      ] as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    await f.store.commit([update(a, "A streaming"), update(b, "B first")], BACKGROUND_CONTEXT);
    await f.store.commit([update(b, "B last")], BACKGROUND_CONTEXT);
    await f.store.commit(
      [
        {
          type: "entry",
          value: {
            id: 12 as never,
            conversationId: 1 as never,
            kind: "pi.assistant",
            model: [answer],
          },
        },
        { type: "document.change", id: a, content: { kind: "base", version: 1, value: {} } },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    const expected = await f.store.document(b, "current", BACKGROUND_CONTEXT);
    const fresh = new DurablePostgresProjection(database, f.projection.scope);
    for (const batch of batches) await fresh.apply(batch, [], at(batch));
    expect([...fresh.liveState.rows.keys()]).toEqual([11]);
    await database
      .transaction()
      .execute((tx) => fresh.checkpointLiveIn(tx, fresh.liveState.fork()));
    const cold = await PublishedDurableStorage.open({
      projection: fresh,
      publish: async () => {},
      waitProjected: async () => {},
    });
    expect(await cold.document(b, "current", BACKGROUND_CONTEXT)).toEqual(expected);
    expect(await cold.document(a, "current", BACKGROUND_CONTEXT)).toMatchObject({ value: {} });
    expect((await cold.entry(12 as never, BACKGROUND_CONTEXT))?.entry.model).toEqual([answer]);
    await cold.close(BACKGROUND_CONTEXT);
  } finally {
    await f.close();
  }
});

it.each(["missing", "old_sequence", "changed_body"] as const)(
  "requires the latest proof for interleaved pending live documents (%s)",
  async (damage) => {
    const f = await fixture();
    const a = 10 as import("@earendil-works/pi-durable").DocumentId,
      b = 11 as typeof a;
    const update = (id: typeof a, text: string): StorageWrite => ({
      type: "document.change",
      id,
      content: {
        kind: "delta",
        version: 1,
        ops: [["s", ["generation"], { attempt: 1, message: { text } }]],
      },
    });
    try {
      await f.store.commit(
        [
          { type: "conversation", value: { id: 1 } },
          { type: "conversation", value: { id: 2 } },
          ...[a, b].map((id, index) => ({
            type: "document.create",
            record: {
              id,
              kind: "pi.live",
              scope: { kind: "conversation", conversationId: index + 1 },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: {} },
          })),
        ] as StorageWrite[],
        BACKGROUND_CONTEXT,
      );
      await f.store.commit([update(a, "A early")], BACKGROUND_CONTEXT);
      const early = f.projection.liveState.rows.get(a)!;
      await f.store.commit([update(a, "A middle")], BACKGROUND_CONTEXT);
      await f.store.commit([update(b, "B first")], BACKGROUND_CONTEXT);
      await f.store.commit([update(a, "A final")], BACKGROUND_CONTEXT);
      await f.store.commit([update(b, "B final")], BACKGROUND_CONTEXT);
      const pending = await sql<{ id: string; replay_seq: string }>`select id::text,replay_seq::text
        from pi_durable_current where tenant_id=${f.tenantId}::uuid and replay_seq is not null order by id`.execute(
        database,
      );
      expect(pending.rows).toEqual([
        { id: "10", replay_seq: "2" },
        { id: "11", replay_seq: "4" },
      ]);
      const bad = f.projection.liveState.fork();
      if (damage === "missing") bad.rows.delete(a);
      else if (damage === "old_sequence") bad.rows.set(a, early);
      else {
        const latest = bad.rows.get(a)!;
        const body = JSON.parse(latest.body);
        body.content.value.generation.message.text = "changed after projection";
        bad.rows.set(a, { ...latest, body: JSON.stringify(body) });
      }
      await expect(
        database.transaction().execute((tx) => f.projection.checkpointLiveIn(tx, bad)),
      ).rejects.toThrow("checkpoint is incomplete or changed");
      await expect(f.projection.assertComplete()).rejects.toThrow("Kafka recovery");
      await database
        .transaction()
        .execute((tx) => f.projection.checkpointLiveIn(tx, f.projection.liveState.fork()));
      await f.projection.assertComplete();
      expect((await f.projection.revisions(a, 6))[0]?.checkpoint).toEqual({
        generation: { attempt: 1, message: { text: "A final" } },
      });
      expect((await f.projection.revisions(b, 6))[0]?.checkpoint).toEqual({
        generation: { attempt: 1, message: { text: "B final" } },
      });
    } finally {
      await f.close();
    }
  },
);

it("keeps one Inbox/Submission body across edits, atomically consumes it, and rebuilds without edit history", async () => {
  const f = await fixture();
  const id = 2 as import("@earendil-works/pi-durable").DocumentId;
  const submission = {
    id: 3 as never,
    conversationId: 1 as never,
    type: "input" as const,
    requestId: "input-stable",
  };
  const initial: StorageWrite[] = [
    { type: "conversation", value: { id: 1 as never } },
    {
      type: "document.create",
      record: {
        id,
        kind: "pi.inbox",
        scope: { kind: "conversation", conversationId: 1 as never },
        history: "latest",
        fork: "initial",
      },
      content: {
        kind: "base",
        version: 1,
        value: { items: [{ id: 3, mode: "followUp", content: "SUPERSEDED_QUEUE_BODY" }] },
      },
    },
    { type: "submission", value: { ...submission, status: "queued" } },
  ];
  try {
    await f.store.commit(initial, BACKGROUND_CONTEXT);
    for (let n = 1; n <= 130; n++) {
      await f.store.commit(
        [
          {
            type: "document.change",
            id,
            content: {
              kind: "delta",
              version: 1,
              ops: [["s", ["items", 0, "content"], `edited-${n}\u0000\ud800`]],
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      if (n % 19 === 0) await f.store.flush();
      if (n % 17 === 0)
        expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
          value: { items: [{ content: `edited-${n}\u0000\ud800` }] },
          deltasSinceBase: n,
        });
    }
    await f.store.flush();
    expect(await f.store.document(id, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { items: [{ content: "edited-130\u0000\ud800" }] },
      deltasSinceBase: 130,
    });
    const current = await sql<{
      body: string;
    }>`select body from pi_durable_current where tenant_id=${f.tenantId}::uuid`.execute(database);
    expect(current.rows).toHaveLength(2);
    expect(current.rows.map((r) => r.body).join("\n")).not.toContain("SUPERSEDED_QUEUE_BODY");
    expect(await f.projection.revisions(id, f.store.committedSequence)).toHaveLength(1);
    expect(
      (
        await sql`select 1 from pi_durable_document_revisions where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    const history = await sql<{
      body: string;
    }>`select body from pi_durable_log where tenant_id=${f.tenantId}::uuid`.execute(database);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.body).not.toContain("QUEUE_BODY");
    // An old acknowledged batch is an idempotent no-op, never a rewind of the queue.
    expect(await f.projection.apply({ seq: 1 as never, nextId: 4, writes: initial })).toBe(false);
    await expect(f.projection.apply({ seq: 1 as never, nextId: 4, writes: [] })).rejects.toThrow(
      "changed bytes",
    );
    const before = await f.projection.revisions(id, f.store.committedSequence);
    // A failed retained Entry insert must also roll back queue removal and its receipt.
    await expect(
      f.projection.apply({
        seq: (f.store.committedSequence + 1) as never,
        nextId: 4,
        writes: [
          {
            type: "document.change",
            id,
            content: { kind: "base", version: 1, value: { items: [] } },
          },
          {
            type: "entry",
            value: { id: 1 as never, conversationId: 1 as never, kind: "invalid-reused-id" },
          },
        ],
      }),
    ).rejects.toThrow("ownership changed");
    expect(await f.projection.revisions(id, f.store.committedSequence)).toEqual(before);
    await f.store.commit(
      [
        {
          type: "document.change",
          id,
          content: { kind: "base", version: 1, value: { items: [] } },
        },
        { type: "submission", value: { ...submission, status: "placed", entry: 4 as never } },
        {
          type: "entry",
          value: {
            id: 4 as never,
            conversationId: 1 as never,
            kind: "pi.user",
            model: [{ role: "user", content: "edited-130\u0000\ud800", timestamp: 1 }],
          },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    const snapshot = async () =>
      (
        await sql`select id,kind,seq,ordinal,fields,created_seq,retired_seq from pi_durable_records where tenant_id=${f.tenantId}::uuid order by id`.execute(
          database,
        )
      ).rows;
    const indexed = await snapshot();
    await sql`delete from pi_durable_records where tenant_id=${f.tenantId}::uuid`.execute(database);
    await sql`delete from pi_durable_document_revisions where tenant_id=${f.tenantId}::uuid`.execute(
      database,
    );
    await f.projection.rebuild();
    expect(await snapshot()).toEqual(indexed);
    expect((await f.projection.get(3))?.value).toMatchObject({ status: "placed", entry: 4 });
    expect((await f.projection.revisions(id, f.store.committedSequence))[0]!.content).toMatchObject(
      { kind: "base", value: { items: [] } },
    );
    expect((await f.projection.get(4))?.value).toMatchObject({
      model: [{ content: "edited-130\u0000\ud800" }],
    });
    expect(
      (
        await sql`select 1 from pi_durable_log where tenant_id=${f.tenantId}::uuid and record_kind in ('submission','document.create','document.change')`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("retires current input content and replaces its address without retaining the old payload", async () => {
  const f = await fixture();
  const definition = {
    kind: "pi.inbox",
    scope: { kind: "conversation" as const, conversationId: 1 as never },
    history: "latest" as const,
    fork: "initial" as const,
  };
  try {
    await f.store.commit(
      [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "document.create",
          record: { ...definition, id: 2 as never },
          content: { kind: "base", version: 1, value: { items: ["retired-body"] } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.commit(
      [
        { type: "document.retire", id: 2 as never },
        {
          type: "document.create",
          record: { ...definition, id: 3 as never },
          content: { kind: "base", version: 1, value: { items: [] } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    expect(await f.store.document(2 as never, "current", BACKGROUND_CONTEXT)).toBeUndefined();
    expect((await f.store.findDocument(definition, "current", BACKGROUND_CONTEXT))?.id).toBe(3);
    await f.projection.rebuild();
    expect((await f.projection.get(2))?.value).toMatchObject({ retiredAt: 2 });
    expect(
      (
        await sql<{
          body: string;
        }>`select body from pi_durable_current where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        )
      ).rows
        .map((r) => r.body)
        .join("\n"),
    ).not.toContain("retired-body");
  } finally {
    await f.close();
  }
});

it("does not apply input retention to an unrelated scope sharing the same document kind", async () => {
  const f = await fixture();
  try {
    await f.store.commit(
      [
        {
          type: "document.create",
          record: { id: 2 as never, kind: "pi.inbox", scope: { kind: "session" } },
          content: { kind: "base", version: 1, value: { value: "before" } },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.commit(
      [
        {
          type: "document.change",
          id: 2 as never,
          content: { kind: "delta", version: 1, ops: [["s", ["value"], "after"]] },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await f.store.flush();
    expect(await f.store.document(2 as never, "current", BACKGROUND_CONTEXT)).toMatchObject({
      value: { value: "after" },
    });
    expect(
      (
        await sql`select 1 from pi_durable_current where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(["missing state", "changed state", "missing history", "changed history"])(
  "rejects %s during index rebuild and preserves existing indexes",
  async (damage) => {
    const f = await fixture();
    try {
      await f.store.commit(
        [
          { type: "conversation", value: { id: 1 as never } },
          {
            type: "document.create",
            record: {
              id: 2 as never,
              kind: "pi.inbox",
              scope: { kind: "conversation", conversationId: 1 as never },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: { items: [] } },
          },
        ],
        BACKGROUND_CONTEXT,
      );
      await f.store.flush();
      if (damage === "missing state")
        await sql`delete from pi_durable_current where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        );
      else if (damage === "changed state")
        await sql`update pi_durable_current set body='{}' where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        );
      else if (damage === "missing history")
        await sql`delete from pi_durable_writes where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        );
      else
        await sql`update pi_durable_writes set body='{}' where tenant_id=${f.tenantId}::uuid`.execute(
          database,
        );
      const before = (
        await sql`select * from pi_durable_records where tenant_id=${f.tenantId}::uuid order by id`.execute(
          database,
        )
      ).rows;
      if (damage === "missing state") {
        await expect(f.projection.get(2)).rejects.toThrow("body is missing");
        await expect(f.projection.scan({ kind: "document" }, 20)).rejects.toThrow(
          "body is missing",
        );
      }
      await expect(f.projection.rebuild()).rejects.toThrow(/integrity|incomplete/);
      expect(
        (
          await sql`select * from pi_durable_records where tenant_id=${f.tenantId}::uuid order by id`.execute(
            database,
          )
        ).rows,
      ).toEqual(before);
    } finally {
      await f.close();
    }
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
    let sequenceVisible = false;
    const sequenceReading = f.store.recordSequence(1).then((sequence) => {
      sequenceVisible = true;
      return sequence;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visible).toBe(false);
    expect(sequenceVisible).toBe(false);
    release.resolve();
    await commit;
    expect(await reading).toEqual({ id: 1 });
    expect(await sequenceReading).toBe(1);
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("ACK lost");
    await expect(f.store.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("uncertain publication");
    await expect(f.store.recordSequence(1)).rejects.toThrow("uncertain publication");
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
      await projection.apply(packed, [], {
        topic: "native-fixture",
        partition: 0,
        offset: BigInt(batch.seq),
      });
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
