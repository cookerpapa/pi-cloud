import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresPiSessionEntryPayloadCache,
  PostgresPiSessionRepository,
  PostgresPiSessionStorage,
  rebuildPostgresPiSessionProjections,
} from "../src/index.ts";

const TENANT_ID = "d1000000-0000-4000-8000-000000000001";
const SESSION_ID = "d1000000-0000-4000-8000-000000000002";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values({ id: TENANT_ID, slug: "pi-session-postgres" })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("PostgresPiSessionStorage", () => {
  it("persists bounded branch context and durable operation records without a JSONL download", async () => {
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      createdAt: 1_700_000_000_000,
    });
    const session = storage.asSession();
    const firstId = await session.appendMessage({
      role: "user",
      content: "first",
      timestamp: 1_700_000_000_000,
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provider: "test",
      model: "test",
      api: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_001,
    });
    const compactId = await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000010",
        type: "compaction",
        summary: "earlier work",
        retainedTail: [],
        tokensBefore: 2,
      },
      "main",
    );
    await session.appendMessage({
      role: "user",
      content: "after compact",
      timestamp: 1_700_000_000_002,
    });

    const leaf = await session.getLeafId();
    expect(leaf).toBeDefined();
    const active = (
      await storage.findEntriesOnBranch({
        start: leaf!,
        stopAtType: "compaction",
        order: "newestFirst",
      })
    ).reverse();
    expect(active.map((entry) => entry.id)).toEqual([compactId.id, leaf]);
    expect((await storage.getEntry(firstId))?.type).toBe("message");

    await storage.appendRecord({
      id: "d1000000-0000-4000-8000-000000000020",
      lane: "main",
      type: "operation_started",
      sourceLeafId: leaf!,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toHaveLength(1);
    await storage.appendRecord({
      id: "d1000000-0000-4000-8000-000000000021",
      lane: "main",
      type: "operation_finished",
      runId: "d1000000-0000-4000-8000-000000000020",
      outcome: "completed",
    });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toEqual([]);

    await storage.setName("durable session");
    await storage.setLabel(leaf!, "current");
    await storage.createLane("review", leaf!);
    expect((await storage.getLog()).map((item) => item.kind)).toEqual([
      "entry",
      "entry",
      "entry",
      "entry",
      "record",
      "record",
      "fact",
      "fact",
      "lane",
    ]);
    const storedLog = await database
      .selectFrom("pi_session_log")
      .select(["seq", "kind", "payload"])
      .where("tenant_id", "=", TENANT_ID)
      .where("session_id", "=", SESSION_ID)
      .orderBy("seq", "asc")
      .execute();
    expect(storedLog.map((item) => Number(item.seq))).toEqual(
      Array.from({ length: storedLog.length }, (_, index) => index + 1),
    );
    for (const item of storedLog) {
      if (item.kind === "entry") {
        expect(item.payload).toMatchObject({
          lane: expect.any(String),
          entry: { id: expect.any(String) },
        });
      }
      if (item.kind === "record") {
        expect(item.payload).toMatchObject({ record: { id: expect.any(String), lane: "main" } });
      }
    }
  });

  it("checks the opaque execution authority before every mutation", async () => {
    let receivedTransaction = false;
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      authority: {
        async assertCurrent(transaction) {
          receivedTransaction = transaction !== undefined;
          throw new Error("stale authority");
        },
      },
    });
    await expect(storage.setName("rejected")).rejects.toThrow("stale authority");
    expect(receivedTransaction).toBe(true);
    await expect(storage.getName()).resolves.toBe("durable session");
  });

  it("routes active Worker mutations through the durable projection port", async () => {
    const operations: unknown[] = [];
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      mutationPublisher: {
        async synchronize() {},
        async mutate(operation) {
          operations.push(operation);
          if (operation.kind === "append_entry") {
            return {
              ...operation.entry,
              parentId: null,
              seq: 999,
              timestamp: 1_700_000_000_999,
            };
          }
        },
      },
    });
    await storage.setName("projected name");
    await expect(
      storage.appendEntry(
        { id: "projected-entry", type: "custom", customType: "projection", data: { ok: true } },
        "main",
      ),
    ).resolves.toMatchObject({ id: "projected-entry", seq: 999 });
    expect(operations).toEqual([
      { kind: "set_name", name: "projected name" },
      {
        kind: "append_entry",
        entry: {
          id: "projected-entry",
          type: "custom",
          customType: "projection",
          data: { ok: true },
        },
        lane: "main",
      },
    ]);
    await expect(storage.getName()).resolves.toBe("durable session");
  });

  it("replays one projected mutation ID as one PostgreSQL effect", async () => {
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      projectedMutationId: "d1000000-0000-4000-8000-000000000099",
    });
    const before = await database
      .selectFrom("pi_sessions")
      .select("next_seq")
      .where("tenant_id", "=", TENANT_ID)
      .where("id", "=", SESSION_ID)
      .executeTakeFirstOrThrow();
    await storage.setName("idempotent projection");
    await storage.setName("would be a duplicate");
    const after = await database
      .selectFrom("pi_sessions")
      .select(["next_seq", "name"])
      .where("tenant_id", "=", TENANT_ID)
      .where("id", "=", SESSION_ID)
      .executeTakeFirstOrThrow();
    expect(Number(after.next_seq)).toBe(Number(before.next_seq) + 1);
    expect(after.name).toBe("idempotent projection");
  });

  it("projects one accepted checkpoint as an atomic append-only batch", async () => {
    const mutationId = "d1000000-0000-4000-8000-000000000098";
    const atomicSessionId = "d1000000-0000-4000-8000-000000000094";
    await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId: atomicSessionId,
    });
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: TENANT_ID,
      sessionId: atomicSessionId,
      projectedMutationId: mutationId,
    });
    const items = [
      {
        kind: "append_entry" as const,
        lane: "main",
        entry: {
          id: "d1000000-0000-4000-8000-000000000097",
          type: "custom" as const,
          customType: "atomic-checkpoint",
          data: { phase: "assistant" },
        },
      },
      {
        kind: "append_record" as const,
        record: {
          id: "d1000000-0000-4000-8000-000000000096",
          lane: "main",
          type: "step_attempt" as const,
          runId: "d1000000-0000-4000-8000-000000000095",
          step: "assistant" as const,
          attempt: 1,
          resultEntryId: "d1000000-0000-4000-8000-000000000097",
        },
      },
    ];
    const before = await storage.getStats();
    const projected = await storage.appendItems(items);
    expect(projected.items).toHaveLength(2);
    await expect(storage.appendItems(items)).resolves.toEqual(projected);
    const marked = await database
      .selectFrom("pi_session_log")
      .select(["seq", "mutation_id"])
      .where("tenant_id", "=", TENANT_ID)
      .where("session_id", "=", atomicSessionId)
      .where("mutation_id", "=", mutationId)
      .execute();
    expect(marked).toHaveLength(1);
    expect((await storage.getStats()).messageCount).toBe(before.messageCount);
    await expect(storage.getEntry("d1000000-0000-4000-8000-000000000097")).resolves.toMatchObject({
      customType: "atomic-checkpoint",
    });
    await expect(
      storage.findRecords({
        type: "step_attempt",
        runId: "d1000000-0000-4000-8000-000000000095",
      }),
    ).resolves.toHaveLength(1);
  });

  it("forks by reference without copying inherited JSON payloads", async () => {
    const entryPayloadCache = new PostgresPiSessionEntryPayloadCache({
      maximumBytes: 1024 * 1024,
      maximumEntryBytes: 256 * 1024,
    });
    const repository = new PostgresPiSessionRepository({
      database,
      tenantId: TENANT_ID,
      entryPayloadCache,
    });
    const source = await repository.openById(SESSION_ID);
    await source.view("main").findEntriesOnBranch();
    const warmed = entryPayloadCache.snapshot();
    expect(warmed.entries).toBe(4);
    const fork = await repository.fork(await source.getMetadata(), {
      id: "shared-entry-fork",
      scope: "branch",
    });
    const inherited = await database
      .selectFrom("pi_session_entry_refs")
      .select(["id", "source_session_id as sourceSessionId"])
      .where("tenant_id", "=", TENANT_ID)
      .where("session_id", "=", "shared-entry-fork")
      .orderBy("seq")
      .execute();
    expect(inherited).toHaveLength(4);
    expect(new Set(inherited.map((entry) => entry.sourceSessionId))).toEqual(new Set([SESSION_ID]));
    await expect(
      database
        .selectFrom("pi_session_entries")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", "shared-entry-fork")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
    expect((await fork.view("main").findEntriesOnBranch()).map((entry) => entry.id)).toEqual(
      inherited.map((entry) => entry.id).reverse(),
    );
    expect(entryPayloadCache.snapshot()).toMatchObject({
      misses: warmed.misses,
      hits: warmed.hits + 4,
    });
    const ownEntryId = await fork.appendMessage({
      role: "user",
      content: "fork-only delta",
      timestamp: 1_700_000_000_003,
    });
    await expect(fork.getEntry(ownEntryId)).resolves.toMatchObject({
      message: { role: "user", content: "fork-only delta" },
    });
    expect((await fork.getLog()).filter((item) => item.kind === "entry")).toHaveLength(5);
    const forkLog = await database
      .selectFrom("pi_session_log")
      .select(["kind", "payload"])
      .where("tenant_id", "=", TENANT_ID)
      .where("session_id", "=", "shared-entry-fork")
      .orderBy("seq", "asc")
      .execute();
    expect(forkLog.slice(0, 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "entry",
          payload: expect.objectContaining({
            entry: expect.objectContaining({ id: expect.any(String), type: expect.any(String) }),
          }),
        }),
      ]),
    );

    const nested = await repository.fork(await fork.getMetadata(), {
      id: "nested-shared-entry-fork",
      scope: "branch",
    });
    await expect(
      database
        .selectFrom("pi_session_entry_refs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", "nested-shared-entry-fork")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "5" });
    expect((await nested.view("main").findEntriesOnBranch()).map((entry) => entry.id)).toContain(
      ownEntryId,
    );
  });

  it("matches Pi branch ordering, bounds, filters and limits in one recursive query", async () => {
    const sessionId = "d1000000-0000-4000-8000-000000000030";
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId,
    });
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000031",
        type: "message",
        message: { role: "user", content: "root", timestamp: 1 },
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000032",
        type: "custom",
        customType: "note",
        data: 1,
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000033",
        type: "compaction",
        summary: "summary",
        retainedTail: [],
        tokensBefore: 2,
      },
      "main",
    );
    await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000034",
        type: "custom",
        customType: "note",
        data: 2,
      },
      "main",
    );
    const tail = await storage.appendEntry(
      {
        id: "d1000000-0000-4000-8000-000000000035",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "tail" }],
          provider: "test",
          model: "test",
          api: "test",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      "main",
    );

    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          stopAtType: "custom",
          order: "oldestFirst",
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000031", "d1000000-0000-4000-8000-000000000032"]);
    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          stopAtType: "custom",
          order: "newestFirst",
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000035", "d1000000-0000-4000-8000-000000000034"]);
    expect(
      (
        await storage.findEntriesOnBranch({
          start: tail.id,
          customType: "note",
          limit: 1,
        })
      ).map((entry) => entry.id),
    ).toEqual(["d1000000-0000-4000-8000-000000000034"]);
    await expect(
      storage.findEntriesOnBranch({
        start: "d1000000-0000-4000-8000-000000000039",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rebuilds multi-Lane query projections from the self-contained Session log", async () => {
    const sessionId = "append-only-multi-lane";
    const storage = await PostgresPiSessionStorage.create({
      database,
      tenantId: TENANT_ID,
      sessionId,
    });
    const root = await storage.appendEntry(
      {
        id: "append-only-root",
        type: "message",
        message: { role: "user", content: "shared context", timestamp: 1 },
      },
      "main",
    );
    await storage.createLane("child-branch", root.id);
    await storage.createLane("child-fresh", null);
    const branched = await storage.appendEntry(
      {
        id: "append-only-branched",
        type: "message",
        message: { role: "user", content: "inherited child task", timestamp: 2 },
      },
      "child-branch",
    );
    const fresh = await storage.appendEntry(
      {
        id: "append-only-fresh",
        type: "message",
        message: { role: "user", content: "prompt-only child task", timestamp: 3 },
      },
      "child-fresh",
    );
    await storage.appendRecord({
      id: "append-only-operation",
      lane: "child-branch",
      type: "operation_started",
      sourceLeafId: branched.id,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await storage.appendRecord({
      id: "append-only-finished",
      lane: "child-branch",
      type: "operation_finished",
      runId: "append-only-operation",
      outcome: "completed",
    });
    await storage.setName("append-only replay");
    await storage.setLabel(root.id, "shared-root");
    const canonicalLog = await storage.getLog();

    await database.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom("pi_session_labels")
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", sessionId)
        .execute();
      await transaction
        .deleteFrom("pi_session_records")
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", sessionId)
        .execute();
      await transaction
        .deleteFrom("pi_session_lanes")
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", sessionId)
        .execute();
      await transaction
        .deleteFrom("pi_session_entries")
        .where("tenant_id", "=", TENANT_ID)
        .where("session_id", "=", sessionId)
        .execute();
      await transaction
        .updateTable("pi_sessions")
        .set({ name: "corrupt projection", next_seq: 999 })
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
    });

    await rebuildPostgresPiSessionProjections(database, { tenantId: TENANT_ID, sessionId });
    await expect(storage.getLog()).resolves.toEqual(canonicalLog);
    await expect(storage.getLanes()).resolves.toEqual([
      { lane: "child-branch", leafId: branched.id },
      { lane: "child-fresh", leafId: fresh.id },
      { lane: "main", leafId: root.id },
    ]);
    await expect(storage.getName()).resolves.toBe("append-only replay");
    await expect(storage.getLabel(root.id)).resolves.toBe("shared-root");
    await expect(storage.findOpenOperations("child-branch")).resolves.toEqual([]);
    await expect(
      storage.findEntriesOnBranch({ start: branched.id, order: "oldestFirst" }),
    ).resolves.toMatchObject([
      { id: root.id, parentId: null },
      { id: branched.id, parentId: root.id },
    ]);
    await expect(
      storage.findEntriesOnBranch({ start: fresh.id, order: "oldestFirst" }),
    ).resolves.toMatchObject([{ id: fresh.id, parentId: null }]);
  });

  it("uses the official repository lifecycle while keeping tenants isolated", async () => {
    const otherTenantId = globalThis.crypto.randomUUID();
    await database
      .insertInto("tenants")
      .values({ id: otherTenantId, slug: `pi-session-other-${otherTenantId}` })
      .executeTakeFirstOrThrow();
    try {
      const repository = new PostgresPiSessionRepository({
        database,
        tenantId: TENANT_ID,
      });
      const session = await repository.openOrCreate({ id: "opaque-session-id" });
      const entryId = await session.appendCustomEntry("contract", { value: 1 });
      const reopened = await repository.openOrCreate({ id: "opaque-session-id" });
      expect(await reopened.getEntry(entryId)).toMatchObject({
        type: "custom",
        customType: "contract",
        data: { value: 1 },
      });

      const otherRepository = new PostgresPiSessionRepository({
        database,
        tenantId: otherTenantId,
      });
      expect(await otherRepository.list()).toEqual([]);
      await expect(
        otherRepository.open({
          ...(await session.getMetadata()),
          tenantId: otherTenantId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await database.deleteFrom("pi_sessions").where("tenant_id", "=", otherTenantId).execute();
      await database.deleteFrom("tenants").where("id", "=", otherTenantId).execute();
    }
  });

  it("checks repository mutation authority in each mutation transaction", async () => {
    const sourceRepository = new PostgresPiSessionRepository({
      database,
      tenantId: TENANT_ID,
    });
    const source = await sourceRepository.create({ id: "authority-source" });
    await source.appendMessage({ role: "user", content: "source", timestamp: 1 });
    const sourceMetadata = await source.getMetadata();
    let receivedTransaction = false;
    const repository = new PostgresPiSessionRepository({
      database,
      tenantId: TENANT_ID,
      authority: {
        async assertCurrent(transaction) {
          receivedTransaction = transaction !== undefined;
          throw new Error("stale repository authority");
        },
      },
    });
    await expect(repository.create({ id: "rejected-session" })).rejects.toThrow(
      "stale repository authority",
    );
    expect(receivedTransaction).toBe(true);
    await expect(
      repository.fork(sourceMetadata, { id: "rejected-fork", scope: "tree" }),
    ).rejects.toThrow("stale repository authority");
    await expect(repository.delete(sourceMetadata)).rejects.toThrow("stale repository authority");
    expect(
      await database
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", "rejected-session")
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", TENANT_ID)
        .where("id", "=", "rejected-fork")
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await sourceRepository.open(sourceMetadata)).toBeDefined();
  });
});
