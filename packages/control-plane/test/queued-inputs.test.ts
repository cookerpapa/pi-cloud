import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { readHumanInputMetadataBatch } from "@pi-cloud/pi-session-postgres/durable";
import { ExecutionStreamProjector } from "@pi-cloud/runtime-core";
import { parseKafkaAcceptedFact } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { readCanonicalPiTurnTranscripts } from "../../runtime-core/src/canonical-pi-conversation.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { startNativeInputAgent } from "./native-input-fixture.ts";
import type {
  NativeInputCommand,
  NativeInputResult,
  NativeInputAccepted,
  AcceptedTurnResource,
} from "@pi-cloud/protocol";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.sequential("native human inputs and cloud execution records", () => {
  let db: Kysely<Database>, admin: Pool, name: string;
  let offset = 0n;
  beforeAll(async () => {
    if (!external) throw new Error("Use the isolated PostgreSQL test runner");
    admin = new Pool({ connectionString: external, max: 1 });
    name = `inputs_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${name}"`);
    const url = new URL(external);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
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
      slug: `q-${randomUUID()}`,
      ownerDisplayName: "Native queue",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "queue", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "queue",
      "elastic",
    );
    const deliver = vi.fn<(c: NativeInputCommand) => Promise<NativeInputResult>>(async () => {
      throw new Error("Worker unavailable");
    });
    const queue = new QueuedInputService({
      database: db,
      backendFactory: async () => ({ humanInput: deliver }),
    });
    const accept = (
      text: string,
      key: string = randomUUID(),
      mode: "follow_up" | "steer" = "follow_up",
    ) => queue.accept(store, tenant.tenantId, session.sessionId, key, { prompt: text }, mode);
    const list = () => queue.list(tenant.tenantId, session.sessionId);
    const edit = (
      inputId: string,
      action: Parameters<typeof queue.mutate>[4],
      key: string = randomUUID(),
    ) => queue.mutate(tenant.tenantId, session.sessionId, inputId, key, action);
    const start = async () => {
      const root = (await accept("initial task")) as AcceptedTurnResource;
      const agent = await startNativeInputAgent(db, tenant.tenantId, root);
      deliver.mockImplementation(agent.backend.humanInput);
      return { root, ...agent };
    };
    return { tenant, store, project, session, queue, deliver, accept, list, edit, start };
  }
  async function seal(runId: string) {
    const row = await db
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload->>'kind'='execution_seal' and payload#>>'{scope,runId}'=${runId}`)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(db).project({
      fact: parseKafkaAcceptedFact(JSON.stringify(row.payload)),
      topic: "native-input-test",
      partition: 0,
      offset: offset++,
    });
  }
  it("stores an idle request in one Run, and edits it without changing original idempotency", async () => {
    const f = await fixture();
    const first = (await f.accept("original", "root")) as AcceptedTurnResource;
    expect(first.kind).toBe("run");
    expect((await f.list()).items[0]).toMatchObject({ inputId: first.turnId, text: "original" });
    const request = {
      action: "edit" as const,
      text: "latest",
      revision: (await f.list()).revision,
    };
    await f.edit(first.turnId, request, "edit");
    expect((await f.edit(first.turnId, request, "edit")).replayed).toBe(true);
    expect((await f.accept("original", "root")).replayed).toBe(true);
    await expect(f.accept("different", "root")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(f.accept("while starting")).rejects.toMatchObject({
      code: "input_delivery_unavailable",
    });
    expect((await f.list()).items.map((i) => i.text)).toEqual(["latest"]);
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toHaveLength(1);
    await f.edit(first.turnId, { action: "cancel", revision: (await f.list()).revision });
    expect((await f.list()).items).toEqual([]);
    expect((await f.accept("next")).kind).toBe("run");
  });
  it("keeps failed delivery as a draft, then durably retries the same identity without a placeholder Run", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      f.deliver.mockRejectedValueOnce(new Error("offline"));
      await expect(f.accept("draft", "same")).rejects.toMatchObject({
        code: "input_delivery_unavailable",
      });
      expect((await f.list()).items).toEqual([]);
      const accepted = (await f.accept("draft", "same")) as NativeInputAccepted;
      expect(accepted).toMatchObject({ kind: "input", runId: a.root.runId, delivery: "follow_up" });
      expect((await f.list()).items[0]).toMatchObject({ inputId: accepted.inputId, text: "draft" });
      expect(
        await db
          .selectFrom("runs")
          .select("id")
          .where("session_id", "=", f.session.sessionId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom("turn_control_requests")
          .select("id")
          .where("session_id", "=", f.session.sessionId)
          .execute(),
      ).toEqual([]);
      expect((await f.accept("draft", "same")).replayed).toBe(true);
      await expect(f.accept("changed", "same")).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    } finally {
      await a.close();
    }
  });
  it("recovers a lost confirmation and edits/promotes the same native submission across API instances", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      f.deliver.mockImplementationOnce(async (c) => {
        await a.backend.humanInput(c);
        throw new Error("response lost");
      });
      await expect(f.accept("original", "lost")).rejects.toMatchObject({
        code: "input_delivery_unavailable",
      });
      const accepted = (await f.accept("original", "lost")) as NativeInputAccepted;
      const edit = { action: "edit" as const, text: "final", revision: (await f.list()).revision };
      await f.edit(accepted.inputId, edit, "edit");
      const replacement = new QueuedInputService({ database: db });
      expect(
        (
          await replacement.mutate(
            f.tenant.tenantId,
            f.session.sessionId,
            accepted.inputId,
            "edit",
            edit,
          )
        ).replayed,
      ).toBe(true);
      await f.edit(accepted.inputId, { action: "steer", revision: (await f.list()).revision });
      expect((await f.list()).items).toMatchObject([
        { inputId: accepted.inputId, text: "final", status: "steering" },
      ]);
      await a.release();
      expect(a.calls[1]).toContain("final");
      expect(a.calls.join("\n")).not.toContain("original");
      expect((await f.list()).items).toEqual([]);
      await expect(
        f.edit(accepted.inputId, {
          action: "edit",
          text: "late",
          revision: (await f.list()).revision,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await f.accept("original", "lost")).replayed).toBe(true);
      const metadata = await readHumanInputMetadataBatch(
        db,
        { tenantId: f.tenant.tenantId, sessionId: f.session.sessionId },
        [{ runId: a.root.runId, conversationId: 1 }],
      );
      expect(metadata.get(a.root.runId)?.inputs[accepted.inputId]?.text).toBe("final");
      // Native user entries are visible even if all display events were lost.
      const cold = await readCanonicalPiTurnTranscripts(db, {
        tenantId: f.tenant.tenantId,
        turnIds: [a.root.turnId],
      });
      expect(cold.get(a.root.turnId)?.items.filter((i) => i.kind === "user")).toMatchObject([
        { inputId: accepted.inputId, text: "final" },
      ]);
      expect(cold.get(a.root.turnId)?.throughSequence).toBe(0);
    } finally {
      await a.close();
    }
  });
  it("rejects stale edits, including moving away and back, and serializes concurrent replicas", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      const first = (await f.accept("one")) as NativeInputAccepted,
        second = (await f.accept("two")) as NativeInputAccepted;
      const old = (await f.list()).revision;
      await f.edit(second.inputId, { action: "move", direction: "up", revision: old });
      await f.edit(second.inputId, {
        action: "move",
        direction: "down",
        revision: (await f.list()).revision,
      });
      await expect(
        f.edit(first.inputId, { action: "edit", text: "stale", revision: old }),
      ).rejects.toMatchObject({ code: "conflict" });
      const revision = (await f.list()).revision;
      const results = await Promise.allSettled([
        f.edit(first.inputId, { action: "edit", text: "A", revision }),
        f.edit(first.inputId, { action: "edit", text: "B", revision }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    } finally {
      await a.close();
    }
  });
  it("pages native inputs with an edit revision independent of model log progress", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      for (let i = 0; i < 23; i++) await f.accept(`pending ${i}`);
      const first = await f.list();
      expect(first.items).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      const cursor = { afterPosition: 20, revision: first.revision };
      const next = await f.queue.list(f.tenant.tenantId, f.session.sessionId, cursor);
      expect(next.items.map((i) => i.text)).toEqual(["pending 20", "pending 21", "pending 22"]);
      await f.edit(next.items[0]!.inputId, {
        action: "move",
        direction: "up",
        revision: first.revision,
      });
      await expect(
        f.queue.list(f.tenant.tenantId, f.session.sessionId, cursor),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(f.queue.list(randomUUID(), f.session.sessionId)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await a.close();
    }
  });
  it("returns only unconsumed human inputs after Stop and ordered seal, preserving edited order", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      const cancelled = (await f.accept("withdraw individually")) as NativeInputAccepted;
      await f.edit(cancelled.inputId, { action: "cancel", revision: (await f.list()).revision });
      const first = (await f.accept("first")) as NativeInputAccepted,
        second = (await f.accept("second")) as NativeInputAccepted;
      await f.edit(second.inputId, {
        action: "move",
        direction: "up",
        revision: (await f.list()).revision,
      });
      const stop = await f.store.acceptTurnCancellation(
        f.session.sessionId,
        a.root.turnId,
        "stop",
        {},
      );
      expect(await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).toMatchObject({
        pending: true,
        items: [],
      });
      await expect(
        f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, {
          requestId: stop.controlRequestId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(f.accept("late")).rejects.toMatchObject({ code: "conflict" });
      await a.abort();
      expect((await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).pending).toBe(true);
      await seal(a.root.runId);
      const returned = await f.queue.returned(f.tenant.tenantId, f.session.sessionId);
      expect(returned.pending).toBe(false);
      expect(returned.items.map((i) => i.inputId)).toEqual([second.inputId, first.inputId]);
      await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, {
        requestId: stop.controlRequestId,
      });
      await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, {
        requestId: stop.controlRequestId,
      });
      expect((await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).items).toEqual([]);
    } finally {
      await a.close();
    }
  });
  it.each(["edit", "cancel", "move"] as const)(
    "rejects initial %s when the claim holds its Run without a lock cycle",
    async (action) => {
      const f = await fixture(),
        root = (await f.accept("initial")) as AcceptedTurnResource;
      const revision = (await f.list()).revision;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const held = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", root.runId)
          .forNoKeyUpdate()
          .execute();
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      try {
        const request =
          action === "edit"
            ? { action, text: "later", revision }
            : action === "move"
              ? { action, direction: "up" as const, revision }
              : { action, revision };
        await expect(f.edit(root.turnId, request)).rejects.toMatchObject({ code: "conflict" });
      } finally {
        release.resolve();
        await held;
      }
      expect((await f.list()).items[0]?.text).toBe("initial");
    },
  );
  it("never returns an already consumed human input after Stop", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      await f.accept("consumed continuation");
      await a.release();
      await f.store.acceptTurnCancellation(f.session.sessionId, a.root.turnId, "stop", {});
      await a.abort();
      await seal(a.root.runId);
      expect(await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).toMatchObject({
        pending: false,
        items: [],
      });
    } finally {
      await a.close();
    }
  });
  it("keeps returned pages stable after acknowledgement by another browser", async () => {
    const f = await fixture(),
      a = await f.start();
    try {
      for (let i = 0; i < 23; i++) await f.accept(`return ${i}`);
      const stop = await f.store.acceptTurnCancellation(
        f.session.sessionId,
        a.root.turnId,
        "stop",
        {},
      );
      await a.abort();
      await seal(a.root.runId);
      const first = await f.queue.returned(f.tenant.tenantId, f.session.sessionId);
      expect(first.items).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, {
        requestId: stop.controlRequestId,
      });
      const second = await f.queue.returned(f.tenant.tenantId, f.session.sessionId, {
        requestId: stop.controlRequestId,
        afterPosition: first.items.at(-1)!.mailboxPosition,
      });
      expect(second.items.map((i) => i.text)).toEqual(["return 20", "return 21", "return 22"]);
      expect(second.hasMore).toBe(false);
    } finally {
      await a.close();
    }
  });
});
