import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { Harness, createRegistry, UsageDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "@pi-cloud/pi-session-postgres/durable";
import { parseConversationUsageResource } from "@pi-cloud/protocol";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { ConversationCompactService } from "../src/conversation-compact-service.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { startNativeInputAgent } from "./native-input-fixture.ts";
import {
  admitManualCompaction,
  manualCompactionState,
} from "../../sandbox-supervisor/src/durable/manual-compaction.ts";
import { createTestWorker } from "./admit-test-execution.ts";

let db: Kysely<Database>, admin: Pool, name: string;
beforeAll(async () => {
  const url = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!url) throw new Error("Use isolated PostgreSQL test runner");
  admin = new Pool({ connectionString: url, max: 1 });
  name = "commands_" + randomUUID().replaceAll("-", "");
  await admin.query(`create database "${name}"`);
  const endpoint = new URL(url);
  endpoint.pathname = "/" + name;
  db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
  await runMigrations(db, "up");
}, 60000);
afterAll(async () => {
  await db?.destroy();
  if (admin) {
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
});
async function fixture() {
  const tenant = await createPrivateTenant(db, {
    slug: "commands-" + randomUUID(),
    ownerDisplayName: "Command contracts",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "commands", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "commands",
    "elastic",
  );
  return { tenant, store, project, session };
}

it("compact history stays scoped while including queued and pre-start-cancelled commands", async () => {
  const own = await fixture(),
    foreign = await fixture();
  const sibling = await own.store.createSession(
    own.project.projectId,
    own.project.workspaceId,
    "sibling",
    "elastic",
  );
  for (const [store, id] of [
    [foreign.store, foreign.session.sessionId],
    [own.store, sibling.sessionId],
  ] as const) {
    const run = await store.acceptTurn(id, randomUUID(), { prompt: "unrelated accepted work" });
    // Only read-model metadata is needed; do not admit an execution writer.
    await db
      .updateTable("runs")
      .set({ state: "completed", started_at: new Date(), settled_at: new Date() })
      .where("id", "=", run.runId)
      .execute();
  }
  expect((await own.store.getConversation(own.session.sessionId)).turns).toEqual([]);
  const service = new ConversationCompactService({ database: db });
  const command = await service.accept(
    own.store,
    own.tenant.tenantId,
    own.session.sessionId,
    randomUUID(),
    {},
  );
  expect(
    (await own.store.getConversation(own.session.sessionId)).turns.map((t) => t.runId),
  ).toEqual([command.runId]);
  const stopKey = randomUUID();
  const stopped = await own.store.acceptTurnCancellation(
    own.session.sessionId,
    command.turnId,
    stopKey,
    {},
  );
  expect(
    (await own.store.acceptTurnCancellation(own.session.sessionId, command.turnId, stopKey, {}))
      .replayed,
  ).toBe(true);
  expect(
    await db
      .selectFrom("turn_control_requests")
      .select(["state", "attempts"])
      .where("id", "=", stopped.controlRequestId)
      .executeTakeFirst(),
  ).toEqual({ state: "completed", attempts: 0 });
  expect(
    await db
      .selectFrom("runs")
      .select(["lease_id", "worker_id"])
      .where("id", "=", command.runId)
      .executeTakeFirst(),
  ).toEqual({ lease_id: null, worker_id: null });
  const history = await own.store.getConversation(own.session.sessionId);
  expect(history.turns).toHaveLength(1);
  expect(history.turns[0]?.operation).toMatchObject({ kind: "compact", state: "cancelled" });
});

it("reads native current usage and context without admitting work or hydrating images", async () => {
  const f = await fixture();
  const empty = await f.store.getConversationUsage(f.session.sessionId);
  expect(empty.tokens.total).toBe(0);
  expect(empty.context.estimatedTokens).toBe(0);
  expect(empty.context.window).toBeGreaterThan(10000);
  const row = await db
    .selectFrom("sessions")
    .select(["pi_session_id"])
    .where("id", "=", f.session.sessionId)
    .executeTakeFirstOrThrow();
  const projection = new DurablePostgresProjection(db, {
    tenantId: f.tenant.tenantId,
    sessionId: row.pi_session_id,
  });
  const storage = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      await projection.apply(batch, [], {
        topic: "commands-fixture",
        partition: 0,
        offset: BigInt(batch.seq),
      });
    },
    waitProjected: async () => {},
  });
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const usage = {
      input: 30,
      output: 20,
      cacheRead: 70,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await root.commit(async (tx) => {
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "retained input", timestamp: 1 }],
      });
      await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            api: "openai-codex-responses",
            provider: empty.model.provider,
            model: empty.model.modelId,
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage,
            timestamp: 2,
          },
        ],
      });
      const state = await tx.doc(UsageDoc, root.id);
      state.models[`${empty.model.provider}/${empty.model.modelId}`] = usage;
    }, BACKGROUND_CONTEXT);
    const result = parseConversationUsageResource(
      await f.store.getConversationUsage(f.session.sessionId),
    );
    expect(result.tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 70,
      cacheWrite: 0,
      total: 120,
    });
    expect(result.context).toMatchObject({ method: "latest_usage", estimatedTokens: 120 });
    expect(result.includingChildren).toEqual(result.tokens);
    await root.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, root.id);
      usage.models[`${empty.model.provider}/${empty.model.modelId}`]!.output += 5;
    }, BACKGROUND_CONTEXT);
    expect((await f.store.getConversationUsage(f.session.sessionId)).tokens.total).toBe(125);
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toHaveLength(0);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

it("cold compact is typed root work, is idempotent, and does not require Workspace compute", async () => {
  const f = await fixture(),
    service = new ConversationCompactService({ database: db });
  await db
    .updateTable("workspaces")
    .set({ deleted_at: new Date() })
    .where("id", "=", f.project.workspaceId)
    .execute();
  const key = randomUUID();
  const accepted = await service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {});
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", accepted.runId)
    .executeTakeFirstOrThrow();
  expect(row.operation_kind).toBe("compact");
  expect(row.input_text).toBe("");
  expect(row.input_uploads).toEqual([]);
  expect(
    (await service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {})).runId,
  ).toBe(accepted.runId);
  const queue = new QueuedInputService({ database: db });
  expect((await queue.list(f.tenant.tenantId, f.session.sessionId)).items).toHaveLength(0);
  await expect(
    queue.accept(f.store, f.tenant.tenantId, f.session.sessionId, randomUUID(), {
      prompt: "keep as draft",
    }),
  ).rejects.toThrow("draft");
  const worker = await createTestWorker(db);
  await worker
    .executor({
      execute: async (request) => {
        expect(request.input).toMatchObject({
          kind: "compact",
          commandId: accepted.commandId,
          instructions: "",
        });
        return { stopReason: "compact_no_op" };
      },
    })
    .dispatchRun(accepted.runId);
  expect(
    (await service.get(f.tenant.tenantId, f.session.sessionId, accepted.commandId))?.state,
  ).toBe("no_op");
  const replay = await service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {});
  expect(replay.replayed).toBe(true);
  expect(replay.state).toBe("no_op");
  expect(
    await db
      .selectFrom("runs")
      .select("id")
      .where("session_id", "=", f.session.sessionId)
      .execute(),
  ).toHaveLength(1);
});

it("active compact reuses the current Run and resolves a lost Worker reply from native state", async () => {
  const f = await fixture();
  const accepted = await f.store.acceptTurn(f.session.sessionId, randomUUID(), {
    prompt: "hold native task",
  });
  const agent = await startNativeInputAgent(db, f.tenant.tenantId, accepted);
  let deliveries = 0;
  const service = new ConversationCompactService({
    database: db,
    backendFactory: async () => ({
      ...agent.backend,
      compact: async (command) => {
        deliveries++;
        const receipt = await admitManualCompaction(
          agent.runtime.harness,
          agent.storage,
          agent.conversation,
          {
            requestId: command.commandId,
            fingerprint: command.fingerprint,
            runId: command.runId,
            requestedAt: command.requestedAt,
            ...(command.instructions ? { instructions: command.instructions } : {}),
          },
        );
        const status = await manualCompactionState(
          agent.runtime.harness,
          agent.conversation.id,
          command.commandId,
        );
        if (deliveries === 1) throw new Error("lost acceptance reply");
        return {
          commandId: command.commandId,
          taskId: receipt.taskId,
          nativeSequence: 999,
          requestedAt: receipt.requestedAt,
          state: status!.state,
          replayed: receipt.replayed,
        };
      },
    }),
  });
  try {
    const key = randomUUID();
    await expect(
      service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {}),
    ).rejects.toMatchObject({ code: "input_delivery_unavailable" });
    const retry = await service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {});
    expect(retry.runId).toBe(accepted.runId);
    expect(retry.replayed).toBe(true);
    expect(deliveries).toBe(1);
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toHaveLength(1);
    await expect(
      service.accept(f.store, f.tenant.tenantId, f.session.sessionId, key, {
        instructions: "different",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  } finally {
    await agent.release();
    await agent.close();
  }
});
