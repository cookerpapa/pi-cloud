// Owned PG measurements. Current public adapters run; no real provider or sandbox is invoked.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
  PostgresDurableSessionHost,
} from "../../../packages/pi-session-postgres/src/durable/index.ts";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";

const output = resolve(
  process.argv[2] ?? "dist/reviews/worker-harness-recovery-cost-20261019.json",
);
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Isolated native cold reads and child bootstrap source/cursor queries; not total production recovery latency",
  context: [],
  children: [],
};
let pg, db;
const noop = async () => {};
async function contextCost(history) {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await db.insertInto("tenants").values({ id: scope.tenantId, slug: scope.tenantId }).execute();
  await db
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(db, scope);
  const publish = async (batch) =>
    projection.apply(batch, [], { topic: "cost-fixture", partition: 0, offset: BigInt(batch.seq) });
  const storage = await PublishedDurableStorage.open({ projection, publish, waitProjected: noop });
  await storage.commit([{ type: "conversation", value: { id: 1 } }], context);
  for (let offset = 0; offset < history; offset += 250)
    await storage.commit(
      Array.from({ length: Math.min(250, history - offset) }, (_, i) => ({
        type: "entry",
        value: {
          id: offset + i + 2,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "OLD_ARCHIVE " + (offset + i), timestamp: 0 }],
        },
      })),
      context,
    );
  const head = history + 2;
  await storage.commit(
    [
      {
        type: "entry",
        value: {
          id: head,
          conversationId: 1,
          kind: "pi.compaction",
          head,
          model: [{ role: "user", content: "CURRENT_SUMMARY", timestamp: 0 }],
        },
      },
      {
        type: "entry",
        value: {
          id: head + 1,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "ACTIVE_SUFFIX", timestamp: 1 }],
        },
      },
    ],
    context,
  );
  await storage.close(context);
  const queries = [],
    returned = [];
  const measured = db.withPlugin({
    transformQuery({ node, queryId }) {
      queries.push(db.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      for (const r of result.rows) if (typeof r.body === "string") returned.push(r.body);
      return result;
    },
  });
  const cold = await PublishedDurableStorage.open({
    projection: new DurablePostgresProjection(measured, scope),
    publish,
    waitProjected: noop,
  });
  const start = performance.now();
  const runtime = await DurableAgentSession.open(cold, { models: createModels(), remoteTools: [] });
  try {
    const root = await runtime.harness.conversation(1, context);
    const active = await root.context(context);
    assert.deepEqual(
      active.messages.map((m) => m.content),
      ["CURRENT_SUMMARY", "ACTIVE_SUFFIX"],
    );
    assert(!returned.some((body) => body.includes("OLD_ARCHIVE")));
    const result = {
      historicalEntries: history,
      activeEntries: active.entries.length,
      sqlStatements: queries.length,
      returnedBodyBytes: returned.reduce((n, b) => n + Buffer.byteLength(b), 0),
      oldBodiesRead: 0,
      localMs: performance.now() - start,
    };
    report.context.push(result);
  } finally {
    await runtime.close();
  }
}
async function childCost() {
  // The fixture uses its own database on the owned disposable server. Only its
  // native active-view port is controlled; activeConversations executes real SQL.
  const prior = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL = pg.url;
  const f = await nativeSubagentFixture();
  if (prior === undefined) delete process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  else process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL = prior;
  const views = [];
  let selected = [];
  const queries = [];
  let host, handle;
  try {
    for (let i = 0; i < 32; i++) {
      const call = await f.command({ action: "run", task: "Owned child " + i, tools: [] });
      const child = await f.store.createSession(
        f.project.projectId,
        f.project.workspaceId,
        "Owned child " + i,
        "elastic",
      );
      await f.database
        .updateTable("sessions")
        .set({ pi_session_id: f.scope.piSessionId, session_kind: "subagent" })
        .where("id", "=", child.sessionId)
        .execute();
      const id = randomUUID(),
        turnId = randomUUID();
      await f.database
        .insertInto("subagent_conversations")
        .values({
          id,
          tenant_id: f.scope.tenantId,
          root_run_id: f.scope.runId,
          root_session_id: f.scope.sessionId,
          parent_session_id: f.scope.sessionId,
          parent_turn_id: f.scope.turnId,
          parent_tool_call_id: "task:" + call.taskId,
          parent_execution_id: null,
          depth: 1,
          source_sequence: String(call.nativeSequence),
          source_record_id: String(call.taskId),
          source_kind: "task",
          request_sha256: "a".repeat(64),
          child_session_id: child.sessionId,
          child_turn_id: turnId,
          agent_name: "fixture",
          context_mode: "fresh",
          sandbox_mode: "shared",
        })
        .execute();
      views.push({
        conversationId: 1000 + i,
        view: {
          id,
          sessionId: child.sessionId,
          parentConversationId: 1,
          source: { sequence: call.nativeSequence, taskId: call.taskId },
        },
      });
    }
    const measured = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    host = new PostgresDurableSessionHost({ database: measured, leaseDatabase: f.database });
    handle = await host.open({
      binding: {
        tenantId: f.scope.tenantId,
        piSessionId: f.scope.piSessionId,
        conversationId: 1,
        sessionId: f.scope.sessionId,
        turnId: f.scope.turnId,
        runId: f.scope.runId,
        executionReference: f.reference,
        writerId: f.scope.writerId,
      },
      publish: noop,
    });
    await handle.runtime(async () => ({
      close: noop,
      activeConversationViews: async () => selected,
    }));
    for (const count of [1, 8, 32]) {
      selected = views.slice(0, count);
      queries.length = 0;
      const restored = await host.activeConversations(f.reference);
      assert.equal(restored.length, count);
      assert(restored.every((v, i) => v.prompt === "Owned child " + i));
      const sourceReads = queries.filter((q) => /select body from pi_durable_log/.test(q)).length;
      const cursorReads = queries.filter((q) => q.includes('"subagent_conversations"')).length;
      assert.equal(sourceReads, count);
      assert.equal(cursorReads, count);
      report.children.push({
        activeChildren: count,
        sourceReads,
        cursorReads,
        metadataSqlStatements: sourceReads + cursorReads,
      });
    }
  } finally {
    await handle?.close();
    await host?.close();
    await f.close();
  }
}
try {
  report.probeSha256 = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  pg = await testPostgres({});
  db = createDatabase({ connectionString: pg.url, maxConnections: 4 });
  await runMigrations(db, "up");
  for (const n of [0, 1000, 10000]) await contextCost(n);
  await childCost();
  report.completed = true;
} finally {
  await db?.destroy();
  await pg?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
