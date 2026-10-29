import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PublishedDurableStorage } from "../packages/pi-session-postgres/src/durable/index.ts";
import { captureNativePresentation } from "../packages/runtime-core/src/frozen-history.ts";
import { settleHistoryTurn } from "../packages/runtime-core/src/presentation-settlement.ts";
// Isolated PG and real Fork service. Payloads are synthetic; no model/VM/user data.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { ConversationTreeService } from "../packages/control-plane/src/conversation-tree-service.ts";
import { DurablePostgresProjection } from "../packages/pi-session-postgres/src/durable/index.ts";

assert(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, "Use the isolated PostgreSQL wrapper");
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/fork-performance",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const target = Number(process.env.PI_CLOUD_FORK_CHECK_BYTES ?? 1024 ** 3);
assert(Number.isSafeInteger(target) && target >= 8 * 1024 ** 2);
const report = { at: new Date().toISOString(), accepted: false, targetBytes: target };
const admin = new Pool({ connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, max: 1 });
const name = "fork_perf_" + randomUUID().replaceAll("-", "");
await admin.query(`create database "${name}"`);
const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 3 });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
let failure;
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "fork-perf-" + randomUUID(),
    ownerDisplayName: "Synthetic Fork performance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({
    name: "Synthetic Fork performance",
    source: { kind: "empty" },
  });
  const source = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Source",
    "elastic",
  );
  const run = await store.acceptTurn(source.sessionId, randomUUID(), {
    prompt: "Synthetic history. No execution.",
  });
  const projection = new DurablePostgresProjection(
    db,
    { tenantId: tenant.tenantId, sessionId: source.sessionId },
    undefined,
    "references",
  );
  let seq = 0,
    nextId = 2,
    bytes = 0,
    units = 0;
  const origins = (writes) =>
    writes
      .filter((w) => w.value?.id !== undefined)
      .map((w) => ({
        recordId: w.value.id,
        sessionId: source.sessionId,
        runId: run.runId,
        turnId: run.turnId,
      }));
  const commit = async (writes) => {
    bytes += Buffer.byteLength(JSON.stringify(writes));
    const batch = { seq: ++seq, nextId, writes };
    await db.transaction().execute(async (tx) => {
      await projection.applyIn(tx, batch, origins(writes));
      await captureNativePresentation(
        tx,
        { tenantId: tenant.tenantId, sessionId: source.sessionId },
        seq,
      );
    });
  };
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (id, text, reason = "stop", extra = []) => ({
    type: "entry",
    value: {
      id,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-6-luna",
          content: [{ type: "text", text }, ...extra],
          timestamp: 1793203200000,
          stopReason: reason,
          usage,
        },
      ],
    },
  });
  await commit([{ type: "conversation", value: { id: 1 } }]);
  if (process.env.PI_CLOUD_FORK_CHECK_DOCUMENT === "1")
    await commit([
      {
        type: "document.create",
        record: {
          id: nextId++,
          kind: "fixture.preferences",
          scope: { kind: "conversation", conversationId: 1 },
          history: "rewindable",
          fork: "asOf",
        },
        content: { kind: "base", version: 1, value: { text: "synthetic state ".repeat(512) } },
      },
    ]);
  phase("seed");
  const seedAt = performance.now();
  while (bytes < target) {
    const writes = [];
    for (let i = 0; i < 16; i++) {
      const n = units++,
        a = nextId++,
        task = nextId++,
        result = nextId++;
      const paragraph = `Synthetic item ${n} ` + randomBytes(256).toString("hex");
      writes.push(
        assistant(a, (paragraph + "\n").repeat(28), "toolUse", [
          {
            type: "toolCall",
            id: "repeated-call",
            name: "read",
            arguments: { path: `fixture-${n}.txt` },
          },
        ]),
      );
      writes.push({
        type: "task",
        value: {
          id: task,
          conversationId: 1,
          kind: "pi.tool",
          version: 1,
          input: { assistant: a, callId: "repeated-call" },
          background: false,
          abortRequested: false,
          state: {
            status: "terminal",
            outcome: { status: "completed", result: { entryId: result } },
          },
        },
      });
      writes.push({
        type: "entry",
        value: {
          id: result,
          conversationId: 1,
          byTaskId: task,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolName: "read",
              toolCallId: "repeated-call",
              content: [
                { type: "text", text: ("Result " + n + " " + paragraph + "\n").repeat(82) },
              ],
              isError: false,
              timestamp: 1793203200000,
            },
          ],
        },
      });
    }
    await commit(writes);
  }
  const withContext = process.env.PI_CLOUD_FORK_CHECK_CONTEXT === "1";
  if (withContext) {
    const keep = nextId - 3;
    await commit([
      {
        type: "entry",
        value: {
          id: nextId++,
          conversationId: 1,
          kind: "pi.compaction",
          head: keep,
          model: [
            { role: "user", content: "Older synthetic work is summarized here.", timestamp: 1 },
          ],
        },
      },
    ]);
  }
  const final = nextId++;
  await commit([assistant(final, "FORK_END")]);
  await db
    .updateTable("runs")
    .set({
      state: "completed",
      started_at: new Date(),
      settled_at: new Date(),
      output_display_seq: String(seq + 1),
      output_display_native_seq: String(seq),
    })
    .where("id", "=", run.runId)
    .execute();
  await db
    .updateTable("sessions")
    .set({ state: "idle" })
    .where("id", "=", source.sessionId)
    .execute();
  await db
    .transaction()
    .execute((tx) => settleHistoryTurn(tx, tenant.tenantId, source.sessionId, run.turnId));
  await sql`analyze pi_history_records; analyze pi_durable_owned_records; analyze pi_history_bodies`.execute(
    db,
  );
  report.seed = {
    bytes,
    units,
    entries: 2 * units + 1 + (withContext ? 1 : 0),
    milliseconds: performance.now() - seedAt,
  };
  const measure = async (sessionId, label) => {
    let sampleQuery;
    const pending = new WeakMap(),
      totals = { queries: 0, outboundBytes: 0, inboundBytes: 0, sqlMs: 0, stages: {}, kinds: {} };
    const byteSize = (value) =>
      typeof value === "string"
        ? Buffer.byteLength(value)
        : value === null || value === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(value));
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        const q = db.getExecutor().compileQuery(node, queryId);
        const category = q.sql.includes("insert into pi_history_snapshots")
          ? "snapshot_write"
          : q.sql.includes("insert into pi_history_bodies")
            ? "body_intern"
            : q.sql.includes("insert into pi_durable_commits")
              ? "native_commit"
              : q.sql.includes("pi_durable_log")
                ? "native_read"
                : "other";
        pending.set(queryId, { at: performance.now(), category, compiled: q });
        totals.queries++;
        totals.outboundBytes += q.parameters.reduce((n, p) => n + byteSize(p), 0);
        return node;
      },
      async transformResult({ result, queryId }) {
        const q = pending.get(queryId),
          elapsed = performance.now() - q.at;
        if (
          !sampleQuery &&
          result.rows[0]?.copied > 0 &&
          q.compiled.sql.includes("with owner as materialized")
        )
          sampleQuery = q.compiled;
        totals.sqlMs += elapsed;
        const k = (totals.kinds[q.category] ??= { queries: 0, milliseconds: 0 });
        k.queries++;
        k.milliseconds += elapsed;
        totals.inboundBytes += result.rows.reduce((n, row) => n + byteSize(row), 0);
        return result;
      },
    });
    const service = new ConversationTreeService({
      database: measured,
      onForkTiming: (stage, ms) => {
        totals.stages[stage] = ms;
      },
    });
    const start = performance.now(),
      cpu = process.cpuUsage();
    let peak = process.memoryUsage().rss;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    timer.unref();
    try {
      const fork = await service.fork(tenant.tenantId, sessionId, randomUUID(), {
        turnId: run.turnId,
        entryId: String(final),
      });
      const measuredCpu = process.cpuUsage(cpu);
      report[label] = {
        ...totals,
        milliseconds: performance.now() - start,
        cpuMs: (measuredCpu.user + measuredCpu.system) / 1000,
        peakRss: peak,
      };
      if (process.env.PI_CLOUD_FORK_EXPLAIN === "1" && sampleQuery) {
        const probe = randomUUID();
        const plan = await db.transaction().execute(async (tx) => {
          await tx
            .insertInto("pi_sessions")
            .values({ tenant_id: tenant.tenantId, id: probe })
            .execute();
          await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes,cloud_metadata)
            select tenant_id,${probe},seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes,cloud_metadata
            from pi_durable_commits where tenant_id=${tenant.tenantId}::uuid and session_id=${fork.session.sessionId} and seq=1`.execute(
            tx,
          );
          await sql`insert into pi_durable_writes(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin,entry_body_id,entry_conversation_id,entry_task_id)
            select tenant_id,${probe},seq,ordinal,record_kind,record_id,body,phase,cloud_origin,entry_body_id,entry_conversation_id,entry_task_id
            from pi_durable_writes where tenant_id=${tenant.tenantId}::uuid and session_id=${fork.session.sessionId} and seq=1`.execute(
            tx,
          );
          const result = await tx.executeQuery({
            ...sampleQuery,
            sql: "explain (analyze,buffers,format json) " + sampleQuery.sql,
            parameters: sampleQuery.parameters.map((p) =>
              p === fork.session.sessionId ? probe : p,
            ),
          });
          await tx
            .deleteFrom("pi_sessions")
            .where("tenant_id", "=", tenant.tenantId)
            .where("id", "=", probe)
            .execute();
          return result;
        });
        await writeFile(
          resolve(directory, label + "-plan.json"),
          JSON.stringify(plan.rows, null, 2),
          { mode: 0o600 },
        );
      }
      const readAt = performance.now();
      const view = await store.getConversation(fork.session.sessionId);
      report[label].coldHistoryReadMs = performance.now() - readAt;
      assert(JSON.stringify(view).includes("FORK_END"));
      if (withContext) {
        const nativeAt = performance.now();
        const binding = await db
          .selectFrom("sessions")
          .select(["pi_session_id", "pi_conversation_id"])
          .where("id", "=", fork.session.sessionId)
          .executeTakeFirstOrThrow();
        const storage = await PublishedDurableStorage.open({
          projection: new DurablePostgresProjection(
            db,
            { tenantId: tenant.tenantId, sessionId: binding.pi_session_id },
            undefined,
            "references",
          ),
          publish: async () => {
            throw new Error("Context check must not mutate storage");
          },
          waitProjected: async () => {},
        });
        const harness = await Harness.open(
          storage,
          { models: createModels({ providers: [] }), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        try {
          const context = await (
            await harness.conversation(Number(binding.pi_conversation_id), BACKGROUND_CONTEXT)
          ).context(BACKGROUND_CONTEXT);
          const encoded = JSON.stringify(context.messages);
          assert(encoded.includes("Older synthetic work is summarized here."));
          assert(encoded.includes("FORK_END"));
          assert(Buffer.byteLength(encoded) < 128 * 1024);
          report[label].nativeContext = {
            milliseconds: performance.now() - nativeAt,
            bytes: Buffer.byteLength(encoded),
            messages: context.messages.length,
          };
        } finally {
          await harness.close(BACKGROUND_CONTEXT);
        }
      }
      return fork.session.sessionId;
    } finally {
      clearInterval(timer);
    }
  };
  phase("first");
  const first = await measure(source.sessionId, "first");
  phase("nested");
  let latest = await measure(first, "nested");
  const depth = Number(process.env.PI_CLOUD_FORK_CHECK_DEPTH ?? 2);
  for (let i = 2; i < depth; i++) {
    const result = await new ConversationTreeService({ database: db }).fork(
      tenant.tenantId,
      latest,
      randomUUID(),
      { turnId: run.turnId, entryId: String(final) },
    );
    latest = result.session.sessionId;
    if (i % 100 === 0) phase("depth-" + i);
  }
  if (depth > 2) await measure(latest, "deep");
  const inventory = (
    await sql`select count(*)::int objects,sum(payload_bytes)::text as bytes from pi_history_bodies where tenant_id=${tenant.tenantId}::uuid and body_kind='entry'`.execute(
      db,
    )
  ).rows[0];
  assert.equal(inventory.objects, report.seed.entries);
  report.inventory = inventory;
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error.stack ?? error);
} finally {
  await db.destroy();
  await admin.query(`drop database "${name}"`);
  await admin.end();
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
