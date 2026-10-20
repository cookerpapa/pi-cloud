// Native family restore preparation on owned PG. Publication is projected
// synchronously instead of Kafka; admission and infrastructure startup are excluded.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import {
  DurablePostgresProjection,
  PostgresDurableSessionHost,
} from "../../../packages/pi-session-postgres/src/durable/index.ts";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import { RemoteToolSandboxTurnRunner } from "../../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts";
import { CloudModelRegistry } from "../../../packages/sandbox-supervisor/src/durable/model-registry.ts";
import { command as sample } from "../../../packages/sandbox-supervisor/test/fixtures/durable-command.ts";

const output = resolve(process.argv[2] ?? "dist/reviews/family-restore-timing-20261019.json");
const counts = (process.argv[3] ?? "1,8,32").split(",").map(Number);
assert(counts.length > 0 && counts.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 128));
const mode = process.argv[4] ?? "prepare";
assert(["prepare", "stop-during-restore"].includes(mode));
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Already-admitted cold native/Runner restore on owned loopback PG; short fresh text children, no attachments; synchronous PG projection substitutes Kafka publication",
  excluded: [
    "failure detection",
    "old-writer fencing/closure latency",
    "Pod startup",
    "Kafka/RF3 acknowledgement",
    "real model response",
    "VM creation",
  ],
  cases: [],
  mode,
};
let pg;
const round = (n) => Math.round(n * 1000) / 1000;
async function seed(f, count) {
  const journal = [],
    sequences = new Map(),
    children = [];
  let maximum = 1;
  const storage = new (class extends MemoryStorage {
    async commit(writes) {
      const p = this.prepareCommit(writes);
      for (const w of p.writes) {
        const id = w.value?.id ?? w.record?.id ?? w.id;
        maximum = Math.max(maximum, id);
        sequences.set(id, Number(p.seq));
      }
      journal.push({ seq: Number(p.seq), nextId: maximum + 1, writes: structuredClone(p.writes) });
      return p.apply();
    }
  })();
  const models = createModels(),
    provider = fauxProvider({
      provider: "openai-codex",
      models: [{ id: "gpt-6-luna", reasoning: true, contextWindow: 131072, maxTokens: 2048 }],
      tokensPerSecond: 1000000,
    });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(
      Array.from({ length: count }, (_, i) =>
        fauxToolCall("subagent", { action: "run", task: "Short child task " + i, tools: [] }),
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("ROOT ANSWERED"),
  ]);
  let runtime,
    entered = 0;
  const allEntered = Promise.withResolvers();
  const config = (id, tools, view) => ({
    runId: f.scope.runId,
    conversationId: id,
    model: provider.getModel(),
    agent: {},
    context: view
      ? { sessionId: view.sessionId, turnId: view.turnId, view }
      : { sessionId: f.scope.sessionId, turnId: f.scope.turnId },
    tools,
    remoteTools: [],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw Error("No seed remote effect");
    },
    openModel: async (request) => {
      if (id !== 1) {
        entered++;
        if (entered === count) allEntered.resolve();
        await awaitWithContext(
          new Promise(() => {}),
          withAbortSignal(request.options.signal, context),
        );
        throw Error("unreachable");
      }
      return { model: provider.getModel(), options: request.options, release() {} };
    },
  });
  const tool = {
    name: "subagent",
    description: "Owned native seed only",
    parameters: Type.Object({
      action: Type.Literal("run"),
      task: Type.String(),
      tools: Type.Array(Type.String()),
    }),
    execute: async (args, api) => {
      const view = {
        id: randomUUID(),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        parentConversationId: 1,
        ownerTaskId: api.taskId,
        contextAnchor: null,
        workingDirectory: "/workspace",
        computeSessionId: null,
        toolCapabilities: [],
        agentSystemPrompt: "",
        source: { sequence: sequences.get(api.taskId), taskId: api.taskId },
      };
      const id = await runtime.createConversation({
        requestId: view.id,
        ownerTaskId: api.taskId,
        parentConversationId: 1,
        view,
      });
      const child = await runtime.bind(config(id, [], view));
      await child.submit({ type: "input", content: args.task, requestId: f.scope.runId }, context);
      if (mode === "stop-during-restore")
        await child.submit(
          {
            type: "input",
            content: "Owned queued follow-up",
            requestId: "input-stop-fixture",
            whenBusy: "followUp",
          },
          context,
        );
      children.push({ id, view, prompt: args.task });
      return { content: [{ type: "text", text: "Child started" }] };
    },
  };
  runtime = await DurableAgentSession.open(storage, {
    models,
    remoteTools: [],
    infrastructureTools: [tool],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  let prefix;
  try {
    const root = await runtime.bind(config(1, [tool]));
    const submission = await root.submit(
      { type: "input", content: "Create children", requestId: f.scope.runId },
      context,
    );
    await allEntered.promise;
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(children.length, count);
    prefix = structuredClone(journal);
  } finally {
    await runtime.close();
  }
  // Replace only the resource fixture's synthetic root in its disposable DB.
  // Real Harness creation also writes its built-in documents in that first batch.
  assert.equal((await f.projection.head()).seq, 1);
  assert.equal(prefix[0].seq, 1);
  assert.deepEqual(prefix[0].writes[0], { type: "conversation", value: { id: 1 } });
  const removed = await sql`delete from pi_durable_commits
    where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId}
    returning seq`.execute(f.database);
  assert.equal(removed.rows.length, 1);
  const projection = new DurablePostgresProjection(f.database, {
    tenantId: f.scope.tenantId,
    sessionId: f.scope.piSessionId,
  });
  const bindings = new Map([
    [1, { sessionId: f.scope.sessionId, turnId: f.scope.turnId }],
    ...children.map((c) => [c.id, { sessionId: c.view.sessionId, turnId: c.view.turnId }]),
  ]);
  for (const batch of prefix) {
    const origins = batch.writes.flatMap((w) => {
      const b = bindings.get(w.value?.conversationId);
      return b ? [{ recordId: w.value.id, runId: f.scope.runId, ...b }] : [];
    });
    await projection.apply(batch, origins, {
      topic: "owned-native-seed",
      partition: 0,
      offset: BigInt(batch.seq),
    });
  }
  await f.database
    .transaction()
    .execute((tx) => projection.checkpointLiveIn(tx, projection.liveState.fork()));
  await projection.assertComplete();
  const rootRow = await f.database
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", f.scope.sessionId)
    .executeTakeFirstOrThrow();
  for (const c of children) {
    await f.database
      .insertInto("sessions")
      .values({
        ...rootRow,
        id: c.view.sessionId,
        pi_session_id: f.scope.piSessionId,
        pi_conversation_id: String(c.id),
        session_kind: "subagent",
        title: "Owned child",
        tool_capabilities: JSON.stringify([]),
        next_event_seq: "1",
      })
      .execute();
    await f.database
      .insertInto("subagent_conversations")
      .values({
        id: c.view.id,
        tenant_id: f.scope.tenantId,
        root_run_id: f.scope.runId,
        root_session_id: f.scope.sessionId,
        parent_session_id: f.scope.sessionId,
        parent_turn_id: f.scope.turnId,
        parent_tool_call_id: "task:" + c.view.ownerTaskId,
        parent_execution_id: null,
        depth: 1,
        source_sequence: String(c.view.source.sequence),
        source_record_id: String(c.view.source.taskId),
        source_kind: "task",
        request_sha256: "a".repeat(64),
        child_session_id: c.view.sessionId,
        child_turn_id: c.view.turnId,
        agent_name: "fixture",
        context_mode: "fresh",
        sandbox_mode: "shared",
      })
      .execute();
  }
  return {
    children,
    provider: provider.provider,
    model: provider.getModel(),
    prefixBytes: Buffer.byteLength(JSON.stringify(prefix)),
    commits: prefix.length,
  };
}

async function measure(count) {
  const prior = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL = pg.url;
  const f = await nativeSubagentFixture();
  if (prior === undefined) delete process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  else process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL = prior;
  const directory = await mkdtemp(join(tmpdir(), "pi-family-restore-timing-"));
  let host,
    work,
    deadline,
    measuredSuccessfully = false;
  const configure = CloudModelRegistry.prototype.configure;
  const stop = new AbortController();
  try {
    const seeded = await seed(f, count);
    // Preserve the same faux model descriptor across the cold boundary. The
    // model-permit port below still prevents any actual provider request.
    CloudModelRegistry.prototype.configure = function () {
      this.models.setProvider(seeded.provider);
      return seeded.model;
    };
    const projection = new DurablePostgresProjection(f.database, {
      tenantId: f.scope.tenantId,
      sessionId: f.scope.piSessionId,
    });
    let sqlCount = 0,
      commits = 0,
      nativeOpenMs,
      allBoundMs,
      readyChildren = 0,
      vmActivations = 0;
    const measured = f.database.withPlugin({
      transformQuery({ node }) {
        sqlCount++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    host = new PostgresDurableSessionHost({ database: measured, leaseDatabase: f.database });
    const firstEffect = Promise.withResolvers();
    const allEffects = Promise.withResolvers();
    const permitChildren = new Set();
    let started;
    const runner = new RemoteToolSandboxTurnRunner({
      trustedWorkspaceDirectory: directory,
      runtimeIdentity: {
        supervisorId: "owned-benchmark",
        bootId: randomUUID(),
        sandboxId: "owned-benchmark",
      },
      broker: {
        create: async () => {
          vmActivations++;
          throw Error("No VM expected");
        },
        release: async () => ({ retained: false }),
        refreshServices: async () => {},
        workflowUrlFor: () => {
          throw Error("No workflow expected");
        },
      },
      conversations: host,
      openConversationLog: () => ({ publish: async () => {}, close: async () => {} }),
      openAgentSession: async (c) => {
        const p = c.payload;
        const h = await host.open({
          binding: {
            tenantId: p.tenantId,
            piSessionId: p.piSession.id,
            conversationId: p.piSession.conversationId,
            sessionId: p.sessionId,
            turnId: p.turnId,
            runId: p.runId,
            executionReference: p.executionReference,
            writerId: p.piSession.writerId,
          },
          publish: async (publication) => {
            commits++;
            await projection.apply(publication.commit, publication.origins, {
              topic: "owned-restore",
              partition: 0,
              offset: BigInt(publication.commit.seq),
            });
          },
        });
        if (p.piSession.conversationId === 1) nativeOpenMs = performance.now() - started;
        return h;
      },
      modelRuntimeLeaseResolver: () => ({
        runtime: {
          kind: "openai_compatible_gateway",
          provider: "openai-codex",
          modelId: "gpt-6-luna",
          api: "openai-codex-responses",
          baseUrl: "http://127.0.0.1:1",
          capability: "owned-fixture",
          reasoning: true,
          inputModalities: ["text"],
          hostedTools: [],
          contextWindow: 131072,
          autoCompactTokenLimit: 100000,
          maxTokens: 2048,
          serviceTier: null,
          requestTimeoutMs: 300000,
        },
        release: async () => {},
      }),
      acquireModelPermit: async (c, signal) => {
        assert.equal(readyChildren, count);
        const id = c.payload.piSession.conversationId;
        assert(seeded.children.some((child) => child.id === id));
        firstEffect.resolve(performance.now() - started);
        permitChildren.add(id);
        if (permitChildren.size === count) allEffects.resolve(performance.now() - started);
        await awaitWithContext(new Promise(() => {}), withAbortSignal(signal, context));
        throw Error("unreachable");
      },
    });
    const startChild = runner.restoreConversation.bind(runner);
    runner.restoreConversation = async (...args) => {
      const value = await startChild(...args);
      readyChildren++;
      if (readyChildren === count) allBoundMs = performance.now() - started;
      if (mode === "stop-during-restore" && readyChildren === 1)
        stop.abort({
          kind: "pi-cloud.turn-cancellation",
          reason: "user_request",
          gracePeriodMs: 1000,
        });
      return value;
    };
    const command = structuredClone(sample);
    Object.assign(command.payload, {
      tenantId: f.scope.tenantId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      executionReference: f.reference,
      piSession: { id: f.scope.piSessionId, conversationId: 1, writerId: f.scope.writerId },
      toolCapabilities: [],
      input: { kind: "prompt", text: "Create children" },
    });
    Object.assign(command.payload.model, { provider: "openai-codex", modelId: "gpt-6-luna" });
    const memoryBefore = process.memoryUsage();
    started = performance.now();
    work = runner.run(command, async () => {}, stop.signal);
    void work.catch(() => {});
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error("Owned restore benchmark exceeded 120s")), 120000);
    });
    if (mode === "stop-during-restore") {
      const outcome = await Promise.race([
        work.then(
          () => undefined,
          (error) => error,
        ),
        timeout,
      ]);
      assert.equal(outcome?.code, "turn_cancelled");
      assert.equal(permitChildren.size, 0);
      assert.equal(vmActivations, 0);
      const current =
        await sql`select body from pi_durable_current where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId} and kind='submission'`.execute(
          f.database,
        );
      const queued = current.rows
        .map((row) => JSON.parse(row.body).value)
        .filter((value) => value.requestId === "input-stop-fixture");
      assert.equal(queued.length, count);
      assert(queued.every((input) => input.status === "unanswered"));
      const result = {
        activeChildren: count,
        cancelledAfterFirstChildBinding: true,
        modelPermitRequests: 0,
        vmActivations: 0,
        queuedInputStatus: queued[0].status,
        queuedInputCount: queued.length,
        stopSettledMs: round(performance.now() - started),
      };
      report.cases.push(result);
      measuredSuccessfully = true;
      console.log(JSON.stringify({ phase: "stopped", ...result }));
      return;
    }
    const allEffectsMs = await Promise.race([
      allEffects.promise,
      work.then(() => {
        throw Error("Run settled before restore was ready");
      }),
      timeout,
    ]);
    clearTimeout(deadline);
    const memoryAfter = process.memoryUsage();
    const effectMs = await firstEffect.promise;
    assert.equal(vmActivations, 0);
    const result = {
      activeChildren: count,
      nativeHeadOpenMs: round(nativeOpenMs),
      allChildBindingsMs: round(allBoundMs),
      firstModelPermitRequestMs: round(effectMs),
      allChildModelPermitRequestsMs: round(allEffectsMs),
      sqlStatementsExcludingLeaseObserver: sqlCount,
      nativeCommitsProjectedSynchronously: commits,
      seedCommits: seeded.commits,
      seedSerializedBytes: seeded.prefixBytes,
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    };
    report.cases.push(result);
    measuredSuccessfully = true;
    console.log(JSON.stringify({ phase: "measured", ...result }));
  } finally {
    clearTimeout(deadline);
    stop.abort({ kind: "pi-cloud.turn-cancellation", reason: "user_request", gracePeriodMs: 1000 });
    let outcome;
    if (work) {
      outcome = await work.then(
        () => undefined,
        (error) => error,
      );
    }
    CloudModelRegistry.prototype.configure = configure;
    await host?.close();
    await f.close();
    await rm(directory, { recursive: true, force: true });
    if (measuredSuccessfully) assert.equal(outcome?.code, "turn_cancelled");
  }
}
try {
  report.probeSha256 = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  pg = await testPostgres({});
  for (const n of counts) await measure(n);
  report.completed = true;
} finally {
  await pg?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
