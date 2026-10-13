import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { readHumanInputMetadataBatch } from "@pi-cloud/pi-session-postgres/durable";
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
  function queryGate(matches: (query: string) => boolean) {
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const selected = new WeakSet<object>();
    let used = false;
    const database = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (!used && matches(db.getExecutor().compileQuery(node, queryId).sql)) {
          used = true;
          selected.add(queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (selected.has(queryId)) {
          held.resolve();
          await release.promise;
        }
        return result;
      },
    });
    return { database, held, release };
  }
  async function waitForLock() {
    await vi.waitFor(async () => {
      const { rows } = await admin.query(
        "select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
        [name],
      );
      expect(rows[0].n).toBeGreaterThan(0);
    });
  }

  it("uses eight intake queries and two retry queries without rereading the locked Session", async () => {
    const f = await fixture(),
      queries: string[] = [];
    const statements = new WeakMap<object, string>();
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        statements.set(queryId, db.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result, queryId }) {
        queries.push(statements.get(queryId)!);
        return result;
      },
    });
    const store = new ControlPlaneStore({ database: measured, ...f.tenant });
    const queue = new QueuedInputService({ database: measured });
    const accept = () =>
      queue.accept(store, f.tenant.tenantId, f.session.sessionId, "budget", {
        prompt: "one input",
      });
    const first = await accept();
    expect(first.kind).toBe("run");
    // Driver BEGIN/COMMIT are separate; these are completed business statements.
    expect(queries).toHaveLength(8);
    expect(queries.filter((q) => q.includes('from "sessions" as "session_row"'))).toHaveLength(1);
    expect(queries.filter((q) => q.startsWith('with "accepted_run"'))).toHaveLength(1);
    queries.length = 0;
    expect(await accept()).toEqual({ ...first, replayed: true });
    expect(queries).toHaveLength(2);
  });

  it.each([false, true])(
    "rechecks initial idempotency after a replica waits for the Session (changed=%s)",
    async (changed) => {
      const f = await fixture();
      const gate = queryGate(
        (q) => q.includes('from "sessions" as "session_row"') && q.includes("for no key update"),
      );
      const firstStore = new ControlPlaneStore({ database: gate.database, ...f.tenant });
      const first = f.queue.accept(firstStore, f.tenant.tenantId, f.session.sessionId, "race", {
        prompt: "original",
      });
      void first.catch(gate.held.reject);
      let second: ReturnType<typeof f.accept> | undefined;
      try {
        await gate.held.promise;
        second = f.accept(changed ? "changed" : "original", "race");
        const both = Promise.allSettled([first, second]);
        await waitForLock();
        gate.release.resolve();
        const [a, b] = await both;
        expect(a.status).toBe("fulfilled");
        if (a.status !== "fulfilled") throw a.reason;
        if (changed)
          expect(b).toMatchObject({ status: "rejected", reason: { code: "idempotency_conflict" } });
        else expect(b).toEqual({ status: "fulfilled", value: { ...a.value, replayed: true } });
        expect(
          await db
            .selectFrom("runs")
            .select("id")
            .where("session_id", "=", f.session.sessionId)
            .execute(),
        ).toHaveLength(1);
        expect(
          (
            await db
              .selectFrom("sessions")
              .select("next_mailbox_position")
              .where("id", "=", f.session.sessionId)
              .executeTakeFirstOrThrow()
          ).next_mailbox_position,
        ).toBe("2");
      } finally {
        gate.release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );

  it.each(["model-first", "input-first"] as const)(
    "retains model-change ordering while reusing admission state (%s)",
    async (order) => {
      const f = await fixture();
      const gate = queryGate((q) =>
        order === "model-first"
          ? q.startsWith('update "sessions"')
          : q.includes('from "sessions" as "session_row"') && q.includes("for no key update"),
      );
      const measured = new ControlPlaneStore({ database: gate.database, ...f.tenant });
      const model = (store: ControlPlaneStore) =>
        store.updateSessionModel(f.session.sessionId, {
          provider: "openai-codex",
          modelId: "gpt-6-luna",
          thinkingLevel: "low",
          fastMode: false,
        });
      const input = (store: ControlPlaneStore) =>
        f.queue.accept(store, f.tenant.tenantId, f.session.sessionId, "model-race", {
          prompt: "frozen model",
        });
      const first = order === "model-first" ? model(measured) : input(measured);
      void first.catch(gate.held.reject);
      let second: Promise<unknown> | undefined;
      try {
        await gate.held.promise;
        second = order === "model-first" ? input(f.store) : model(f.store);
        const both = Promise.allSettled([first, second]);
        await waitForLock();
        gate.release.resolve();
        const [a, b] = await both;
        expect(a.status).toBe("fulfilled");
        if (order === "model-first") expect(b.status).toBe("fulfilled");
        else expect(b).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
        const rows = await db
          .selectFrom("runs")
          .select(["provider", "model_id", "thinking_level"])
          .where("session_id", "=", f.session.sessionId)
          .execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject(
          order === "model-first"
            ? { provider: "openai-codex", model_id: "gpt-6-luna", thinking_level: "low" }
            : { provider: "pi-cloud-fake", model_id: "pi-cloud-fake" },
        );
      } finally {
        gate.release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );

  it("rolls intake back and rejects admission actions after their transaction ends", async () => {
    const f = await fixture();
    let escaped!: () => Promise<AcceptedTurnResource>;
    await expect(
      f.store.withInputAdmission(
        f.session.sessionId,
        "rollback",
        { prompt: "retry" },
        async (admission) => {
          escaped = admission.acceptInitial;
          await admission.acceptInitial();
          throw new Error("injected intake rollback");
        },
      ),
    ).rejects.toThrow("injected intake rollback");
    await expect(escaped()).rejects.toThrow("Input admission transaction has ended");
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await db
          .selectFrom("sessions")
          .select("next_mailbox_position")
          .where("id", "=", f.session.sessionId)
          .executeTakeFirstOrThrow()
      ).next_mailbox_position,
    ).toBe("1");
    const accepted = await f.accept("retry", "rollback");
    expect(accepted).toMatchObject({ kind: "run", replayed: false });
    const replay = await f.store.withInputAdmission(
      f.session.sessionId,
      "rollback",
      { prompt: "retry" },
      async (admission) => {
        escaped = admission.acceptInitial;
        return admission.acceptInitial();
      },
    );
    expect(replay).toEqual({ ...accepted, replayed: true });
    await expect(escaped()).rejects.toThrow("Input admission transaction has ended");
  });

  it("checks Workspace availability after acquiring the reusable Session snapshot", async () => {
    const f = await fixture();
    await expect(
      f.store.withInputAdmission(
        f.session.sessionId,
        "deleted-workspace",
        { prompt: "reject" },
        async (admission) => {
          await db
            .updateTable("workspaces")
            .set({ deleted_at: new Date() })
            .where("id", "=", f.project.workspaceId)
            .execute();
          return admission.acceptInitial();
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toEqual([]);
  });

  it("rejects mismatched tenant scope before initial or native input acceptance", async () => {
    const f = await fixture();
    await expect(
      f.queue.accept(f.store, randomUUID(), f.session.sessionId, "wrong-tenant", {
        prompt: "reject",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await db
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toEqual([]);
    expect(f.deliver).not.toHaveBeenCalled();
  });

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
      const current = await sql<{ body: string }>`select body from pi_durable_current
        where tenant_id=${f.tenant.tenantId}::uuid`.execute(db);
      expect(current.rows.map((row) => row.body).join("\n")).not.toContain("withdraw individually");
      const historical = await sql<{ body: string }>`select body from pi_durable_log
        where tenant_id=${f.tenant.tenantId}::uuid`.execute(db);
      expect(historical.rows.map((row) => row.body).join("\n")).not.toContain(
        "withdraw individually",
      );
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
      await a.projectCompletion();
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
      await a.projectCompletion();
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
      await a.projectCompletion();
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
