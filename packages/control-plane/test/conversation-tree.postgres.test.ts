import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { createSession, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "@pi-cloud/pi-session-postgres/durable";
import { appendNativeFixture } from "./fixtures/durable-native.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { sql, type Kysely, type QueryId } from "kysely";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { ConversationTreeService } from "../src/conversation-tree-service.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { readCanonicalPiTurnTranscripts } from "../../runtime-core/src/canonical-pi-conversation.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

describe.skipIf(!endpoint)("Conversation tree durable Turn bindings", () => {
  const name = `pi_tree_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
    await runMigrations(db, "up");
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      try {
        await vi.waitFor(async () => {
          const active = await sql<{ n: number }>`select count(*)::int as n
            from pg_stat_activity where datname=${name}`.execute(admin);
          expect(active.rows[0]!.n).toBe(0);
        });
        await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  });

  async function fixture() {
    const tenant = await createPrivateTenant(db, {
      slug: `tree-${randomUUID()}`,
      ownerDisplayName: "Tree regression",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Tree", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Tree",
      "elastic",
    );
    const service = new ConversationTreeService({ database: db });
    async function turn(prompt: string, state: "completed" | "failed" | "queued") {
      const accepted = await store.acceptTurn(session.sessionId, randomUUID(), { prompt });
      const scope = {
        tenantId: tenant.tenantId,
        sessionId: session.sessionId,
        turnId: accepted.turnId,
        runId: accepted.runId,
      };
      const nativeUser = (
        await appendNativeFixture(db, scope, [
          { kind: "pi.user", model: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        ])
      )[0]!;
      const user = { id: String(nativeUser.id) };
      let answer: { id: string } | undefined;
      async function respond(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
        const value = (
          await appendNativeFixture(db, scope, [
            {
              kind: "pi.assistant",
              model: [
                {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  api: "openai-completions",
                  provider: "test",
                  model: "test",
                  stopReason,
                  timestamp: Date.now(),
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
              ],
            },
          ])
        )[0]!;
        answer = { id: String(value.id) };
        return answer;
      }
      if (state !== "failed") await respond(`${prompt} answer`);
      if (state !== "queued") {
        const terminal = {
          state,
          settled_at: new Date(),
          stop_reason: "stop",
          ...(state === "failed" ? { failure_code: "worker_lost", failure_retryable: false } : {}),
        };
        await db.updateTable("turns").set(terminal).where("id", "=", accepted.turnId).execute();
        await db.updateTable("runs").set(terminal).where("id", "=", accepted.runId).execute();
        await db
          .updateTable("sessions")
          .set({ state: "idle" })
          .where("id", "=", session.sessionId)
          .execute();
      }
      return { ...accepted, user, answer, respond };
    }
    const tree = () => service.tree(tenant.tenantId, session.sessionId, "focus");
    return { ...tenant, project, store, session, service, turn, tree };
  }

  it("does not attach a failed prompt to the next successful Turn", async () => {
    const f = await fixture();
    await f.turn("failed question", "failed");
    const successful = await f.turn("successful question", "completed");
    expect((await f.tree()).branches[0]!.entries.map((e) => [e.entryId, e.turnId, e.text])).toEqual(
      [
        [successful.user.id, successful.turnId, "successful question"],
        [successful.answer!.id, successful.turnId, "successful question answer"],
      ],
    );
  });

  it("does not replace a completed answer with an unsealed next Turn's answer", async () => {
    const f = await fixture();
    const completed = await f.turn("completed", "completed");
    await f.turn("not settled", "queued");
    expect((await f.tree()).branches[0]!.entries.map((e) => [e.entryId, e.turnId])).toEqual([
      [completed.user.id, completed.turnId],
      [completed.answer!.id, completed.turnId],
    ]);
  });

  it("uses the final answer of each Turn without dropping earlier completed Turns", async () => {
    const f = await fixture();
    const first = await f.turn("first", "completed");
    const second = await f.turn("second", "completed");
    const latest = await second.respond("second revised answer");
    expect((await f.tree()).branches[0]!.entries.map((e) => [e.entryId, e.turnId])).toEqual([
      [first.user.id, first.turnId],
      [first.answer!.id, first.turnId],
      [second.user.id, second.turnId],
      [latest.id, second.turnId],
    ]);
  });

  it("retains inherited Turn bindings in a Fork's self-contained log and projection rebuild", async () => {
    const f = await fixture();
    const first = await f.turn("fork anchor", "completed");
    await db
      .insertInto("session_terminal_events")
      .values({
        event_id: randomUUID(),
        tenant_id: f.tenantId,
        session_id: f.session.sessionId,
        turn_id: first.turnId,
        run_id: first.runId,
        agent_id: "root",
        schema_version: 1,
        seq: 3,
        type: "turn.completed",
        payload: { stopReason: "stop" },
        occurred_at: new Date(),
      })
      .execute();
    const before = await readCanonicalPiTurnTranscripts(db, {
      tenantId: f.tenantId,
      turnIds: [first.turnId],
    });
    expect(before.get(first.turnId)?.items).toMatchObject([
      { kind: "text", text: "fork anchor answer" },
    ]);
    const fork = await f.service.fork(f.tenantId, f.session.sessionId, randomUUID(), {
      turnId: first.turnId,
      entryId: first.answer!.id,
    });
    const nativeScope = { tenantId: f.tenantId, sessionId: fork.session.sessionId };
    const original = (
      await sql<{
        body: string;
      }>`select body from pi_durable_log where tenant_id=${f.tenantId}::uuid
      and session_id=${fork.session.sessionId} order by seq,ordinal`.execute(db)
    ).rows;
    await new DurablePostgresProjection(db, nativeScope).rebuild();
    const entries = await sql<{
      turn_id: string;
    }>`select fields->>'turn' as turn_id from pi_durable_records
      where tenant_id=${f.tenantId}::uuid and session_id=${fork.session.sessionId} and kind='entry' order by id`.execute(
      db,
    );
    expect(entries.rows.map((row) => row.turn_id)).toEqual([first.turnId, first.turnId]);
    expect(
      (
        await sql<{
          body: string;
        }>`select body from pi_durable_log where tenant_id=${f.tenantId}::uuid
      and session_id=${fork.session.sessionId} order by seq,ordinal`.execute(db)
      ).rows,
    ).toEqual(original);
    expect(
      await readCanonicalPiTurnTranscripts(db, { tenantId: f.tenantId, turnIds: [first.turnId] }),
    ).toEqual(before);
    const tree = await f.service.tree(f.tenantId, fork.session.sessionId, "focus");
    expect(tree.branches[0]!.entries.map((e) => e.turnId)).toEqual([first.turnId, first.turnId]);
    expect(tree.branches[1]!.entries).toEqual([]);
  });

  it("copies native fork document policies without carrying execution or task state", async () => {
    const f = await fixture();
    await f.turn("setup", "completed");
    const docs = [
      defineDoc<{ value: string }>({
        kind: "fixture.as-of",
        version: 1,
        scope: "conversation",
        history: "rewindable",
        fork: "asOf",
        initial: () => ({ value: "initial" }),
      }),
      defineDoc<{ value: string }>({
        kind: "fixture.world",
        version: 1,
        scope: "conversation",
        history: "rewindable",
        fork: "current",
        initial: () => ({ value: "initial" }),
      }),
      defineDoc<{ value: string }>({
        kind: "fixture.grant",
        version: 1,
        scope: "conversation",
        history: "rewindable",
        fork: "initial",
        initial: () => ({ value: "initial" }),
      }),
    ];
    async function change(value: string) {
      const projection = new DurablePostgresProjection(db, {
        tenantId: f.tenantId,
        sessionId: f.session.sessionId,
      });
      const storage = await PublishedDurableStorage.open({
        projection,
        publish: async (batch) => {
          await projection.apply(batch);
        },
        waitProjected: async () => {},
      });
      const session = createSession(storage);
      try {
        await session.commit(async (tx) => {
          for (const doc of docs) (await tx.doc(doc, 1 as ConversationId)).value = value;
        }, BACKGROUND_CONTEXT);
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
    }
    await change("at-cutoff");
    const anchor = await f.turn("fork here", "completed");
    await change("current");
    const fork = await f.service.fork(f.tenantId, f.session.sessionId, randomUUID(), {
      turnId: anchor.turnId,
      entryId: anchor.answer!.id,
    });
    const projection = new DurablePostgresProjection(db, {
      tenantId: f.tenantId,
      sessionId: fork.session.sessionId,
    });
    const storage = await PublishedDurableStorage.open({
      projection,
      publish: async () => {
        throw new Error("read-only");
      },
      waitProjected: async () => {},
    });
    try {
      for (const [index, expected] of ["at-cutoff", "current", undefined].entries()) {
        const record = await storage.findDocument(
          {
            kind: docs[index]!.definition.kind,
            scope: { kind: "conversation", conversationId: 1 as ConversationId },
          },
          "current",
          BACKGROUND_CONTEXT,
        );
        expect(
          record
            ? (await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value.value
            : undefined,
        ).toBe(expected);
      }
      expect((await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  });

  it("reports a missing Workspace when forking retained conversation history", async () => {
    const f = await fixture();
    const first = await f.turn("keep history", "completed");
    await f.store.deleteWorkspace(f.project.workspaceId, "release-files");
    const fork = await f.service.fork(f.tenantId, f.session.sessionId, randomUUID(), {
      turnId: first.turnId,
      entryId: first.answer!.id,
    });
    expect(fork.session.workspaceState).toBe("missing");
  });

  it("reports a deleted Workspace on Fork replay without creating another Session", async () => {
    const f = await fixture();
    const first = await f.turn("anchor", "completed");
    const key = randomUUID(),
      request = { turnId: first.turnId, entryId: first.answer!.id };
    const fork = await f.service.fork(f.tenantId, f.session.sessionId, key, request);
    await db
      .updateTable("sessions")
      .set({ state: "idle" })
      .where("id", "=", fork.session.sessionId)
      .execute();
    await f.store.deleteWorkspace(f.project.workspaceId, "release-files");
    const replay = await f.service.fork(f.tenantId, f.session.sessionId, key, request);
    expect(replay.replayed).toBe(true);
    expect(replay.session).toMatchObject({
      sessionId: fork.session.sessionId,
      workspaceState: "missing",
    });
  });

  it("reads head, entries and completed Turns from one snapshot during concurrent publication", async () => {
    const f = await fixture();
    const first = await f.turn("before tree request", "completed");
    const paused = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const queries = new WeakSet<QueryId>();
    const reader = db.withPlugin({
      transformQuery({ node, queryId }) {
        const query = db.getExecutor().compileQuery(node, queryId);
        if (query.sql.includes('"session_kind" as "sessionKind"')) queries.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (queries.has(queryId)) {
          paused.resolve();
          await release.promise;
        }
        return result;
      },
    });
    const pending = new ConversationTreeService({ database: reader }).tree(
      f.tenantId,
      f.session.sessionId,
      "focus",
    );
    try {
      await paused.promise;
      await f.turn("published during tree request", "completed");
    } finally {
      release.resolve();
    }
    expect((await pending).branches[0]!.entries.map((e) => e.turnId)).toEqual([
      first.turnId,
      first.turnId,
    ]);
    expect((await f.tree()).branches[0]!.entries).toHaveLength(4);
  });
});
