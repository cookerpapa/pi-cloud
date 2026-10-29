import { retainIdleFamily } from "../src/durable/history-retention.ts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  createSession,
  defineDoc,
  type ConversationId,
  type EntryRecord,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { PublishedDurableStorage } from "../src/durable/published-storage.ts";
import { DurablePostgresProjection } from "../src/durable/postgres-projection.ts";
import { importForkHistory } from "../src/durable/history-import.ts";
import { reapUnreferencedEntryBodies } from "../src/durable/shared-entry-bodies.ts";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";

const ForkProvenanceDocument = defineDoc(FORK_PROVENANCE_DOCUMENT);

let admin: Kysely<Database>, db: Kysely<Database>;
const name = `entry_bodies_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!endpoint) throw new Error("Use the real PostgreSQL test wrapper");
  admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(endpoint);
  url.pathname = `/${name}`;
  db = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
  await runMigrations(db, "up");
}, 60_000);
afterAll(async () => {
  await db?.destroy();
  if (admin) {
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
});

async function tenant() {
  const id = randomUUID();
  await db.insertInto("tenants").values({ id, slug: id }).execute();
  return id;
}
async function physical(tenantId: string) {
  const scope = { tenantId, sessionId: randomUUID() };
  await db.insertInto("pi_sessions").values({ tenant_id: tenantId, id: scope.sessionId }).execute();
  const projection = new DurablePostgresProjection(db, scope, undefined, "references");
  const open = () =>
    PublishedDurableStorage.open({
      projection,
      publish: async (batch) =>
        void (await projection.apply(batch, [], {
          topic: "shared-entry-fixture",
          partition: 0,
          offset: BigInt(batch.seq),
        })),
      waitProjected: async () => {},
    });
  return { scope, projection, open };
}

it("shares ancestor payloads across independent Sessions and collects only the last released payload", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  const sourceStore = await source.open();
  await sourceStore.commit([{ type: "conversation", value: { id: 1 as never } }], context);
  const sourceSession = createSession(sourceStore);
  await sourceSession.commit(async (tx) => {
    const state = await tx.doc(ForkProvenanceDocument);
    state.origin = {
      sessionId: source.scope.sessionId,
      sourceSessionId: randomUUID(),
      sourceEntryId: "2",
    };
  }, context);
  const entries: EntryRecord[] = [];
  for (const label of ["A", "B", "C", "D", "E"])
    entries.push(
      await sourceSession.commit(
        (tx) =>
          tx.appendEntry(1 as never, {
            kind: "fixture.entry",
            data: { label, unicode: ["nul:\0", "surrogate:\ud800"] },
          }),
        context,
      ),
    );
  const nativeChild = await sourceSession.commit(
    (tx) =>
      tx.forkConversation(1 as never, entries[2]!.id, {
        ownership: { kind: "ownerless" },
      }),
    context,
  );
  const final = await sourceSession.commit(
    (tx) =>
      tx.appendEntry(nativeChild.id, {
        kind: "fixture.entry",
        data: { label: "F" },
      }),
    context,
  );
  await sourceStore.flush();
  const imported = await db.transaction().execute((tx) =>
    importForkHistory(tx, target.scope, {
      ...source.scope,
      sourceProductSessionId: source.scope.sessionId,
      conversationId: nativeChild.id,
      through: final.id,
    }),
  );
  const payloads = (
    await sql<{ n: number }>`select count(*)::int n from pi_history_bodies
    where tenant_id=${id}::uuid`.execute(db)
  ).rows[0]!.n;
  expect(payloads).toBe(6);
  const refs = (
    await sql<{
      session_id: string;
      record_id: string;
      entry_body_id: string;
      body: string | null;
    }>`
    select session_id,record_id::text,entry_body_id,body from pi_durable_writes
    where tenant_id=${id}::uuid and record_kind='entry'`.execute(db)
  ).rows;
  expect(refs).toHaveLength(10);
  expect(refs.every((r) => r.body === null)).toBe(true);
  for (const copied of refs.filter((r) => r.session_id === target.scope.sessionId))
    expect(copied.entry_body_id).toBe(
      refs.find((r) => r.session_id === source.scope.sessionId && r.record_id === copied.record_id)
        ?.entry_body_id,
    );
  await sourceSession.close(context);
  await db
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", id)
    .where("id", "=", source.scope.sessionId)
    .execute();
  expect(await reapUnreferencedEntryBodies(db)).toBe(2); // Only D and E lost their last reference.
  await target.projection.rebuild();
  const read = await target.open();
  try {
    const copied = createSession(read);
    expect(await copied.snapshot(ForkProvenanceDocument, context)).toEqual({
      origin: {
        sessionId: target.scope.sessionId,
        sourceSessionId: source.scope.sessionId,
        sourceEntryId: String(final.id),
      },
    });
    const actual = [
      ...(
        await read.scanEntries(
          { conversationId: imported.conversationId as never },
          20,
          undefined,
          context,
        )
      ).items,
    ].reverse();
    expect(actual.map((e) => e.data)).toEqual([
      ...entries.slice(0, 3).map((e) => e.data),
      final.data,
    ]);
    expect(actual.every((e) => e.byTaskId === undefined)).toBe(true);
    const sizes = (
      await sql<{ bytes: string; actual: string }>`select body_bytes::text bytes,
      octet_length(body)::text actual from pi_durable_log where tenant_id=${id}::uuid`.execute(db)
    ).rows;
    expect(sizes.every((s) => s.bytes === s.actual)).toBe(true);
  } finally {
    await read.close(context);
  }
  await db.deleteFrom("pi_sessions").where("tenant_id", "=", id).execute();
  expect(await reapUnreferencedEntryBodies(db)).toBe(4);
  await db.deleteFrom("tenants").where("id", "=", id).execute();
});

it("protects an uncommitted new reference from concurrent collection", async () => {
  const id = await tenant(),
    old = await physical(id),
    next = await physical(id);
  const writes: StorageWrite[] = [
    { type: "conversation", value: { id: 1 as never } },
    {
      type: "entry",
      value: {
        id: 2 as never,
        conversationId: 1 as never,
        kind: "fixture.entry",
        data: { value: "held" },
      },
    },
  ];
  await old.projection.apply({ seq: 1 as never, nextId: 3, writes });
  await db
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", id)
    .where("id", "=", old.scope.sessionId)
    .execute();
  const ready = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const attaching = db.transaction().execute(async (tx) => {
    await next.projection.applyIn(tx, { seq: 1 as never, nextId: 3, writes });
    ready.resolve();
    await release.promise;
  });
  await ready.promise;
  try {
    expect(await reapUnreferencedEntryBodies(db)).toBe(0);
  } finally {
    release.resolve();
    await attaching;
  }
  expect(await reapUnreferencedEntryBodies(db)).toBe(0);
  expect((await next.projection.get(2))?.value).toMatchObject({ data: { value: "held" } });
  await db.deleteFrom("pi_sessions").where("tenant_id", "=", id).execute();
  expect(await reapUnreferencedEntryBodies(db)).toBe(1);
  await db.deleteFrom("tenants").where("id", "=", id).execute();
});

it("keeps identical payloads in separate tenant scopes", async () => {
  const firstTenant = await tenant(),
    secondTenant = await tenant();
  const first = await physical(firstTenant),
    second = await physical(secondTenant);
  const writes: StorageWrite[] = [
    { type: "conversation", value: { id: 1 as never } },
    {
      type: "entry",
      value: {
        id: 2 as never,
        conversationId: 1 as never,
        kind: "fixture.entry",
        data: { same: true },
      },
    },
  ];
  for (const f of [first, second]) await f.projection.apply({ seq: 1 as never, nextId: 3, writes });
  const objects = (
    await sql<{ tenant_id: string; id: string; sha256: string }>`select tenant_id,id,sha256
    from pi_history_bodies where tenant_id in (${firstTenant}::uuid,${secondTenant}::uuid)`.execute(
      db,
    )
  ).rows;
  expect(objects).toHaveLength(2);
  expect(objects[0]!.sha256).toBe(objects[1]!.sha256);
  expect(objects[0]!.id).not.toBe(objects[1]!.id);
  const foreign = objects.find((o) => o.tenant_id === secondTenant)!;
  await expect(
    sql`update pi_history_records set entry_body_id=${foreign.id}::uuid
    where tenant_id=${firstTenant}::uuid and record_kind='entry'`.execute(db),
  ).rejects.toMatchObject({ code: "23503" });
  for (const id of [firstTenant, secondTenant]) {
    await db.deleteFrom("pi_sessions").where("tenant_id", "=", id).execute();
    await db.deleteFrom("tenants").where("id", "=", id).execute();
  }
});

it("retains native asOf semantics at inherited anchors while ignoring active source live progress", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  const store = await source.open();
  await store.commit([{ type: "conversation", value: { id: 1 as never } }], context);
  const original = createSession(store);
  const historical = defineDoc<{ value: string }>({
    kind: "fixture.historical",
    version: 1,
    scope: "conversation",
    history: "rewindable",
    fork: "asOf",
    initial: () => ({ value: "initial" }),
  });
  const current = defineDoc<{ value: string }>({
    kind: "fixture.current",
    version: 1,
    scope: "conversation",
    history: "rewindable",
    fork: "current",
    initial: () => ({ value: "initial" }),
  });
  const live = defineDoc<{ generation?: Record<string, never> }>({
    kind: "pi.live",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({}),
  });
  const change = (value: string) =>
    original.commit(async (tx) => {
      (await tx.doc(historical, 1 as ConversationId)).value = value;
      (await tx.doc(current, 1 as ConversationId)).value = value;
    }, context);
  await change("A");
  const a = await original.commit(
    (tx) => tx.appendEntry(1 as ConversationId, { kind: "fixture.entry", data: { label: "A" } }),
    context,
  );
  await change("C");
  const c = await original.commit(
    (tx) => tx.appendEntry(1 as ConversationId, { kind: "fixture.entry", data: { label: "C" } }),
    context,
  );
  await change("later-current");
  await original.commit(async (tx) => {
    await tx.doc(live, 1 as ConversationId);
  }, context);
  await original.commit(async (tx) => {
    (await tx.doc(live, 1 as ConversationId)).generation = {};
  }, context);
  await store.flush();
  await expect(source.projection.head(true)).rejects.toThrow("Kafka recovery");
  const imported = await db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute((tx) =>
      importForkHistory(tx, target.scope, {
        ...source.scope,
        sourceProductSessionId: source.scope.sessionId,
        conversationId: 1,
        through: c.id,
      }),
    );
  expect((await source.projection.head()).nextId).toBeLessThan(
    (await target.projection.head()).nextId,
  );
  await original.close(context);
  await db
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", id)
    .where("id", "=", source.scope.sessionId)
    .execute();
  await target.projection.rebuild();
  const copied = createSession(await target.open()),
    root = imported.conversationId as ConversationId;
  try {
    expect(await copied.snapshot(historical, root, context)).toEqual({ value: "C" });
    expect(await copied.snapshot(current, root, context)).toEqual({ value: "later-current" });
    expect(await copied.snapshotAsOf(historical, root, a.id, context)).toEqual({ value: "A" });
    const nested = await copied.commit(
      (tx) => tx.forkConversation(root, a.id, { ownership: { kind: "ownerless" } }),
      context,
    );
    expect(await copied.snapshot(historical, nested.id, context)).toEqual({ value: "A" });
    expect(await copied.snapshot(current, nested.id, context)).toEqual({ value: "later-current" });
  } finally {
    await copied.close(context);
  }
  await db.deleteFrom("pi_sessions").where("tenant_id", "=", id).execute();
  await db.deleteFrom("tenants").where("id", "=", id).execute();
});

it("reorganizes a closed multi-Conversation family without losing child ancestry or retained document state", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  const store = await source.open();
  await store.commit([{ type: "conversation", value: { id: 1 as never } }], context);
  const session = createSession(store);
  const origin = {
    sessionId: source.scope.sessionId,
    sourceSessionId: randomUUID(),
    sourceEntryId: "57",
  };
  await session.commit(async (tx) => {
    (await tx.doc(ForkProvenanceDocument)).origin = origin;
  }, context);
  const entries: EntryRecord[] = [];
  for (const label of ["A", "B", "C", "D", "E"])
    entries.push(
      await session.commit(
        (tx) => tx.appendEntry(1 as never, { kind: "fixture.entry", data: { label } }),
        context,
      ),
    );
  const child = await session.commit(
    (tx) => tx.forkConversation(1 as never, entries[0]!.id, { ownership: { kind: "ownerless" } }),
    context,
  );
  const childEntry = await session.commit(
    (tx) => tx.appendEntry(child.id, { kind: "fixture.entry", data: { label: "child" } }),
    context,
  );
  const root = await session.commit(
    (tx) => tx.forkConversation(1 as never, entries[1]!.id, { ownership: { kind: "ownerless" } }),
    context,
  );
  await store.flush();
  await session.close(context);
  await db
    .transaction()
    .execute((tx) => retainIdleFamily(tx, source.scope, target.scope, [root.id, child.id]));
  expect(await target.projection.get(entries[2]!.id)).toBeUndefined();
  expect(await target.projection.get(entries[1]!.id)).toBeDefined();
  expect(await target.projection.get(childEntry.id)).toBeDefined();
  await target.projection.rebuild();
  const reopened = await target.open();
  expect(await createSession(reopened).snapshot(ForkProvenanceDocument, context)).toEqual({
    origin,
  });
  const visible = await reopened.scanEntries({ conversationId: root.id }, 100, undefined, context);
  expect([...visible.items].reverse().map((e) => (e.data as { label: string }).label)).toEqual([
    "A",
    "B",
  ]);
  const childVisible = await reopened.scanEntries(
    { conversationId: child.id },
    100,
    undefined,
    context,
  );
  expect([...childVisible.items].reverse().map((e) => (e.data as { label: string }).label)).toEqual(
    ["A", "child"],
  );
  await reopened.close(context);
});

it("shares Entry ranges without copying Entry rows or reading whole historical bodies", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  const origin = { sessionId: randomUUID(), runId: randomUUID(), turnId: randomUUID() };
  const markers = ["\0", "\b\f\n\r\t", "\ud800", "\udfff", "😀中文", "\u2028\u2029", '"\\/<>'];
  const entries = Array.from({ length: 35 }, (_, i) => ({
    type: "entry" as const,
    value: {
      id: (i + 3) as never,
      conversationId: 1 as never,
      byTaskId: 2 as never,
      kind: "fixture.entry",
      data: {
        marker: markers[i % markers.length]!,
        sentinel: "ORDINARY_BODY_" + i + "x".repeat(32768),
        nested: { value: 1.25 },
      },
    },
  }));
  await source.projection.apply(
    {
      seq: 1 as never,
      nextId: 40,
      writes: [
        { type: "conversation", value: { id: 1 as never } },
        {
          type: "task",
          value: {
            id: 2,
            conversationId: 1,
            kind: "fixture.task",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            state: { status: "terminal", outcome: { status: "completed", result: null } },
          },
        } as never,
        ...entries,
      ],
    },
    entries.map((e) => ({ recordId: e.value.id, ...origin })),
  );
  const before = (
    await sql`select fingerprint from pi_durable_commits where tenant_id=${id}::uuid and session_id=${source.scope.sessionId}`.execute(
      db,
    )
  ).rows;
  const returned: string[] = [];
  const measured = db.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      returned.push(JSON.stringify(result.rows));
      return result;
    },
  });
  const fork = await measured.transaction().execute((tx) =>
    importForkHistory(tx, target.scope, {
      ...source.scope,
      sourceProductSessionId: source.scope.sessionId,
      conversationId: 1,
      through: entries.at(-1)!.value.id,
    }),
  );
  expect(fork.entryCount).toBe(35);
  // Native forkConversation reads its boundary Entry once. Other old bodies stay in PG.
  expect(returned.join("")).not.toContain("ORDINARY_BODY_0x");
  expect(returned.join("")).not.toContain("ORDINARY_BODY_32x");
  const refs = (
    await sql`select 1 from pi_durable_write_refs r join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
    where r.tenant_id=${id}::uuid and r.session_id=${target.scope.sessionId} and g.record_kind='entry'`.execute(
      db,
    )
  ).rows;
  expect(refs).toHaveLength(0);
  expect(
    (
      await sql`select fingerprint from pi_durable_commits where tenant_id=${id}::uuid and session_id=${source.scope.sessionId}`.execute(
        db,
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await sql`select 1 from pi_durable_commits where tenant_id=${id}::uuid and session_id=${target.scope.sessionId}`.execute(
        db,
      )
    ).rows,
  ).toHaveLength(1);
  const fields = (
    await sql`select id,fields from pi_durable_records where tenant_id=${id}::uuid and session_id=${target.scope.sessionId} order by id`.execute(
      db,
    )
  ).rows;
  await target.projection.rebuild();
  expect(
    (
      await sql`select id,fields from pi_durable_records where tenant_id=${id}::uuid and session_id=${target.scope.sessionId} order by id`.execute(
        db,
      )
    ).rows,
  ).toEqual(fields);
  expect((await target.projection.get(3))?.value).toMatchObject({ data: entries[0]!.value.data });
});

it("verifies shared payload integrity during explicit cold rebuild without depending on the source owner", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  await source.projection.apply({
    seq: 1 as never,
    nextId: 3,
    writes: [
      { type: "conversation", value: { id: 1 as never } },
      {
        type: "entry",
        value: {
          id: 2 as never,
          conversationId: 1 as never,
          kind: "fixture.entry",
          data: { value: "original" },
        },
      },
    ],
  });
  await db.transaction().execute((tx) =>
    importForkHistory(tx, target.scope, {
      ...source.scope,
      sourceProductSessionId: source.scope.sessionId,
      conversationId: 1,
      through: 2,
    }),
  );
  await db
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", id)
    .where("id", "=", source.scope.sessionId)
    .execute();
  await reapUnreferencedEntryBodies(db);
  const before = (
    await sql`select * from pi_durable_records where tenant_id=${id}::uuid and session_id=${target.scope.sessionId} order by id`.execute(
      db,
    )
  ).rows;
  const changed = JSON.stringify({ kind: "fixture.entry", data: { value: "tampered" } });
  await sql`update pi_history_bodies set payload_text=${changed},payload_bytes=${Buffer.byteLength(changed)} where tenant_id=${id}::uuid`.execute(
    db,
  );
  await expect(target.projection.rebuild()).rejects.toThrow("integrity");
  expect(
    (
      await sql`select * from pi_durable_records where tenant_id=${id}::uuid and session_id=${target.scope.sessionId} order by id`.execute(
        db,
      )
    ).rows,
  ).toEqual(before);
});

it("keeps native ID ordering while a Fork excludes IDs published after its captured head", async () => {
  const id = await tenant(),
    source = await physical(id),
    target = await physical(id);
  await source.projection.apply({
    seq: 1 as never,
    nextId: 40,
    writes: [
      { type: "conversation", value: { id: 1 as never } },
      ...[30, 10, 20].map((n) => ({
        type: "entry" as const,
        value: { id: n as never, conversationId: 1 as never, kind: "fixture.entry", data: { n } },
      })),
    ],
  });
  const fork = await db.transaction().execute((tx) =>
    importForkHistory(tx, target.scope, {
      ...source.scope,
      sourceProductSessionId: source.scope.sessionId,
      conversationId: 1,
      through: 30,
    }),
  );
  await source.projection.apply({
    seq: 2 as never,
    nextId: 40,
    writes: [
      {
        type: "entry",
        value: {
          id: 15 as never,
          conversationId: 1 as never,
          kind: "fixture.entry",
          data: { n: 15 },
        },
      },
    ],
  });
  expect(await source.projection.get(15)).toBeDefined();
  expect(await target.projection.get(15)).toBeUndefined();
  await target.projection.rebuild();
  const storage = await target.open();
  try {
    expect(
      (
        await storage.scanEntries(
          { conversationId: fork.conversationId as never },
          10,
          undefined,
          context,
        )
      ).items.map((e) => e.id),
    ).toEqual([30, 20, 10]);
  } finally {
    await storage.close(context);
  }
});

it("retries collection after a skipped reference lock rolls back", async () => {
  const id = await tenant(),
    source = await physical(id);
  await source.projection.apply({
    seq: 1 as never,
    nextId: 3,
    writes: [
      { type: "conversation", value: { id: 1 as never } },
      {
        type: "entry",
        value: {
          id: 2 as never,
          conversationId: 1 as never,
          kind: "fixture.entry",
          data: { value: "orphan after rollback" },
        },
      },
    ],
  });
  await db
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", id)
    .where("id", "=", source.scope.sessionId)
    .execute();
  const locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const tentative = db
    .transaction()
    .execute(async (tx) => {
      await sql`select id from pi_history_records where tenant_id=${id}::uuid and record_kind='entry' for key share`.execute(
        tx,
      );
      locked.resolve();
      await release.promise;
      throw new Error("rollback tentative reference");
    })
    .catch((error) => {
      if (!(error instanceof Error) || error.message !== "rollback tentative reference")
        throw error;
    });
  await locked.promise;
  try {
    expect(await reapUnreferencedEntryBodies(db, 64)).toBe(0);
    expect(
      (
        await sql<{
          pending_gc: boolean;
        }>`select pending_gc from pi_history_streams where tenant_id=${id}::uuid`.execute(db)
      ).rows,
    ).toEqual([{ pending_gc: true }]);
  } finally {
    release.resolve();
    await tentative;
  }
  expect(await reapUnreferencedEntryBodies(db, 64)).toBe(1);
});
