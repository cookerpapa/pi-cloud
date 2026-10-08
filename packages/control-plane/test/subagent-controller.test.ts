import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  createExecutionReference,
  parseExecutionReference,
  type SubagentHostRequest,
  type SubagentControlResult,
  type SubagentControlRequest,
  parseSessionControlChange,
} from "@pi-cloud/protocol";
import { durableFamilyFixture } from "@pi-cloud/pi-session-postgres/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { StorageWrite, ConversationId } from "@earendil-works/pi-durable";
import type {
  AcceptedSubagentCommand,
  AcceptedExecutionSealFact,
} from "@pi-cloud/runtime-core/accepted-fact";
import type { Kysely } from "kysely";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { SubagentController } from "../src/subagent-controller.ts";

let pg: PGlite, socket: PGLiteSocketServer, db: Kysely<Database>;
let tenantId: string, sessionId: string, runId: string, turnId: string, lease: string;
let family: Awaited<ReturnType<typeof durableFamilyFixture>>;
let nextTool = 1;
const hosts: SubagentController[] = [],
  results = new Map<string, SubagentControlResult>();
const scheduled: string[] = [];
const inputs: Array<{ requestId: string; message: string; delivery: string }> = [];
let prepareGate: Promise<void> | undefined;
let failNotifications = 0,
  offset = 0n;
async function deliver(_lease: string, request: SubagentHostRequest) {
  if (request.action === "prepare_conversation") {
    await prepareGate;
    return family.nativeConversations.createChildConversation({
      executionReference: request.executionReference,
      requestId: request.requestId,
      ownerTaskId: request.ownerTaskId,
      at: request.anchor,
    });
  } else if (request.action === "result") {
    if (failNotifications > 0) {
      failNotifications--;
      throw Object.assign(new Error("connection lost"), { retryable: true });
    }
    results.set(request.response.requestId, request.response);
  } else if (request.action === "schedule") scheduled.push(request.runId);
}
function controller(database: Kysely<Database> = db) {
  const value = new SubagentController({
    database,
    managementToken: "x".repeat(48),
    allowInsecureHttp: true,
    ownsPartition: () => true,
    deliver,
    sendInput: async (input) => {
      inputs.push(input);
    },
    treePolicy: { maximumDepth: 4, maximumNodes: 32 },
  });
  hosts.push(value);
  void value.recover().catch(() => {});
  return value;
}
function command(
  request: SubagentControlRequest,
  workflowId: string = crypto.randomUUID(),
): AcceptedSubagentCommand {
  return {
    kind: "subagent_command",
    factId: crypto.randomUUID(),
    scope: {
      tenantId,
      sessionId,
      runId,
      turnId,
      fencingToken: 1,
      piSessionId: sessionId,
      writerId: parseExecutionReference(lease).leaseId,
    },
    executionReference: lease,
    toolCallId: `task:${nextTool++ * 10000000}`,
    workflowId,
    request,
    occurredAt: new Date().toISOString(),
  };
}
const start = (key: string, workflowId?: string) =>
  command(
    {
      action: "start",
      key,
      task: "Check a bounded task",
      context: "fresh",
      sandbox: "shared",
      anchor: null,
    },
    workflowId,
  );
const consume = (host: SubagentController, fact: AcceptedSubagentCommand) =>
  host.consume({ fact, topic: "test", partition: 0, offset: offset++ });
async function response(id: string) {
  await vi.waitFor(
    async () => {
      await propagateChanges();
      expect(results.has(id)).toBe(true);
    },
    { timeout: 5000, interval: 10 },
  );
  return results.get(id)!;
}
const seenChanges = new WeakMap<SubagentController, Set<string>>();
async function propagateChanges() {
  // This fixture simulates the control stream; runtime tests exercise actual Kafka.
  const rows = await db
    .selectFrom("outbox")
    .select(["id", "payload"])
    .where("topic", "=", "session.control.changed.v1")
    .execute();
  for (const host of hosts) {
    let seen = seenChanges.get(host);
    if (!seen) seenChanges.set(host, (seen = new Set()));
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      await host.changed(parseSessionControlChange(row.payload), () => true);
    }
  }
}

beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "subagent-control",
    ownerDisplayName: "Subagent",
    quotas: { maximumProjects: 8, maximumSessions: 32 },
  });
  tenantId = tenant.tenantId;
  await db
    .insertInto("sandbox_domains")
    .values({
      id: "sandbox-domain-subagent",
      display_name: "test",
      state: "active",
      sandbox_control_base_url: "http://broker.internal",
      workspace_storage_key: "test",
      maximum_active_sandboxes: 16,
    })
    .execute();
  const store = new ControlPlaneStore({
    database: db,
    tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
  const project = await store.createProject({ name: "subagent-test", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Parent",
    "elastic",
  );
  sessionId = session.sessionId;
  const accepted = await store.acceptTurn(sessionId, "parent", { prompt: "Delegate" });
  runId = accepted.runId;
  turnId = (
    await db.selectFrom("runs").select("turn_id").where("id", "=", runId).executeTakeFirstOrThrow()
  ).turn_id;
  const sandboxId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  lease = createExecutionReference(leaseId, runId, 1);
  await db
    .insertInto("sandboxes")
    .values({
      id: sandboxId,
      supervisor_id: "test-worker",
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: 8,

      terminated_at: null,
    })
    .execute();
  await db
    .updateTable("runs")
    .set({
      state: "running",
      worker_id: sandboxId,
      lease_id: leaseId,
      fencing_token: 1,
    })
    .where("id", "=", runId)
    .execute();
  await db
    .insertInto("session_leases")
    .values({
      tenant_id: tenantId,
      pi_session_id: sessionId,
      lease_id: leaseId,
      sandbox_id: sandboxId,
      fencing_token: 1,
      valid_until: new Date(Date.now() + 600000),
    })
    .execute();
  await db.updateTable("runs").set({ state: "running" }).where("turn_id", "=", turnId).execute();
  family = await durableFamilyFixture(db, tenantId, sessionId);
  await family.bind(1, turnId, lease);
}, 60000);
afterEach(async () => {
  prepareGate = undefined;
  failNotifications = 0;
  for (const host of hosts.splice(0)) await host.close();
});
afterAll(async () => {
  await family?.close();
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

describe("ordered Subagent admission and delivery", () => {
  it("limits an unrelated seal to its Run instead of scanning global Subagent state", async () => {
    const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(db.getExecutor().compileQuery(node, queryId));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const host = new SubagentController({
      database: measured,
      managementToken: "x".repeat(48),
      allowInsecureHttp: true,
      ownsPartition: () => true,
      deliver,
    });
    const target = crypto.randomUUID();
    const fact = {
      kind: "execution_seal",
      scope: { ...command({ action: "supervisor", operation: "pending" }).scope, runId: target },
    } as AcceptedExecutionSealFact;
    await host.consume({ fact, topic: "test", partition: 0, offset: offset++ });
    await host.close();
    expect(queries).toHaveLength(2);
    expect(
      queries.every(
        (query) => query.parameters.includes(target) && query.parameters.includes(tenantId),
      ),
    ).toBe(true);
    expect(queries.some((query) => query.sql.includes("min(updated_at)"))).toBe(false);
  });

  it("keeps repeated status reads in memory and performs no idle pending scans", async () => {
    const queries: string[] = [];
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(db.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const host = controller(measured),
      fact = start("cached-status");
    await consume(host, fact);
    await response(fact.factId);
    for (let i = 0; i < 2; i++) {
      const warm = command({ action: "status", target: "cached-status" }, fact.workflowId);
      await consume(host, warm);
      await response(warm.factId);
      await propagateChanges();
    }
    queries.length = 0;
    for (let i = 0; i < 10; i++) {
      const status = command({ action: "status", target: "cached-status" }, fact.workflowId);
      await consume(host, status);
      expect((await response(status.factId)).ok).toBe(true);
    }
    expect(
      queries.filter((q) => q.includes('"child_run"') && q.includes('as "executionState"')),
    ).toEqual([]);
    await propagateChanges();
    await new Promise((resolve) => setTimeout(resolve, 100));
    queries.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(queries).toEqual([]);
  });
  it("prepares one native Lane before making its Child runnable; replay does not duplicate it", async () => {
    const host = controller(),
      fact = start("one");
    await consume(host, fact);
    const reply = await response(fact.factId);
    expect(reply.ok).toBe(true);
    const result = reply.result!;
    const child = await db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", result.childSessionId as string)
      .executeTakeFirstOrThrow();
    expect(child.pi_session_id).toBe(sessionId);
    expect(
      await family.storage.conversation(
        Number(child.pi_conversation_id) as ConversationId,
        BACKGROUND_CONTEXT,
      ),
    ).toBeDefined();
    await consume(host, fact);
    const rows = await db
      .selectFrom("subagent_executions")
      .select("id")
      .where("workflow_run_id", "=", fact.workflowId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(scheduled.filter((id) => id === result.childRunId)).toHaveLength(1);
  });
  it("cancels while Lane preparation is pending without blocking log consumption", async () => {
    let release!: () => void;
    prepareGate = new Promise((resolve) => {
      release = resolve;
    });
    const host = controller(),
      fact = start("preparing");
    await consume(host, fact);
    const stop = command({ action: "cancel", target: "preparing" }, fact.workflowId);
    await consume(host, stop);
    expect((await response(stop.factId)).result?.state).toBe("cancelled");
    release();
    const prepared = await response(fact.factId);
    expect(prepared.result?.state).toBe("cancelled");
    expect(scheduled).not.toContain(prepared.result?.childRunId);
  });
  it("recovers a lost result notification after Projector replacement without another Child", async () => {
    failNotifications = 1;
    const first = controller(),
      fact = start("retry");
    await consume(first, fact);
    await vi.waitFor(
      async () => {
        const row = await db
          .selectFrom("subagent_control_commands")
          .select("response")
          .where("id", "=", fact.factId)
          .executeTakeFirstOrThrow();
        expect(row.response).not.toBeNull();
      },
      { timeout: 5000, interval: 10 },
    );
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    failNotifications = 0;
    const next = controller();
    await propagateChanges();
    next.wake();
    expect((await response(fact.factId)).ok).toBe(true);
    const rows = await db
      .selectFrom("subagent_executions")
      .select("id")
      .where("workflow_run_id", "=", fact.workflowId)
      .execute();
    expect(rows).toHaveLength(1);
  });
  it("does not accept a reused control identity with different input", async () => {
    const host = controller(),
      fact = start("identity");
    await consume(host, fact);
    await response(fact.factId);
    await expect(
      consume(host, { ...fact, request: { action: "cancel", target: "other" } }),
    ).rejects.toThrow("identity");
  });
  it("does not start a child for a late request after its parent Tool result", async () => {
    const host = controller(),
      fact = start("late");
    await family.storage.commit(
      [
        {
          type: "task",
          value: {
            id: Number(fact.toolCallId.slice(5)),
            conversationId: 1,
            kind: "pi.tool",
            version: 1,
            input: { assistant: 2, callId: "provider" },
            background: false,
            abortRequested: true,
            state: { status: "terminal", outcome: { status: "aborted" } },
          },
        },
      ] as unknown as StorageWrite[],
      BACKGROUND_CONTEXT,
    );
    await consume(host, fact);
    expect((await response(fact.factId)).ok).toBe(false);
    const rows = await db
      .selectFrom("subagent_executions")
      .select("id")
      .where("workflow_run_id", "=", fact.workflowId)
      .execute();
    expect(rows).toHaveLength(0);
  });
  it("waits for admission, delivers follow-up once and refuses a finished task", async () => {
    const host = controller(),
      fact = start("mailbox");
    await consume(host, fact);
    const child = (await response(fact.factId)).result!;
    const original = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    const send = command(
      { action: "send", target: "mailbox", message: "Follow up code", delivery: "follow_up" },
      fact.workflowId,
    );
    await consume(host, send);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(results.has(send.factId)).toBe(false);
    await db
      .updateTable("runs")
      .set({
        state: "running",
        started_at: new Date(),
        worker_id: original.worker_id,
        lease_id: original.lease_id,
        fencing_token: original.fencing_token,
      })
      .where("id", "=", child.childRunId as string)
      .execute();
    await propagateChanges();
    host.wake();
    expect((await response(send.factId)).result?.state).toBe("accepted");
    await consume(host, send);
    expect(inputs.filter((input) => input.requestId === send.factId)).toHaveLength(1);
    expect(
      inputs
        .filter((input) => input.requestId === send.factId)
        .every((input) => input.delivery === "follow_up"),
    ).toBe(true);
    await db
      .updateTable("subagent_control_commands")
      .set({ input_consumed_at: new Date() })
      .where("id", "=", send.factId)
      .execute();
    await db
      .updateTable("runs")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", child.childRunId as string)
      .execute();
    const late = command(
      { action: "send", target: "mailbox", message: "Too late", delivery: "notify" },
      fact.workflowId,
    );
    await consume(host, late);
    expect((await response(late.factId)).result?.state).toBe("missed");
    expect(inputs.some((input) => input.requestId === late.factId)).toBe(false);
  });
  it("rejects a target outside the physical Session", async () => {
    const host = controller(),
      send = command({
        action: "send",
        target: crypto.randomUUID(),
        message: "No cross-session delivery",
        delivery: "steer",
      });
    await consume(host, send);
    expect((await response(send.factId)).ok).toBe(false);
    expect(inputs.some((input) => input.requestId === send.factId)).toBe(false);
  });
  it("reconciles a terminal child after controller replacement without a surviving result reader", async () => {
    const host = controller(),
      fact = start("abandoned-child");
    await consume(host, fact);
    const child = (await response(fact.factId)).result!;
    await host.close();
    await db
      .updateTable("runs")
      .set({
        state: "failed",
        settled_at: new Date(),
        failure_code: "assignment_lost",
        failure_message: "Worker was lost",
        failure_retryable: false,
      })
      .where("id", "=", child.childRunId as string)
      .execute();
    const replacement = controller();
    await propagateChanges();
    replacement.wake();
    await vi.waitFor(
      async () => {
        const row = await db
          .selectFrom("subagent_executions")
          .select(["state", "failure_code", "settled_at"])
          .where("id", "=", child.executionId as string)
          .executeTakeFirstOrThrow();
        expect(row.state).toBe("failed");
        expect(row.failure_code).toBe("assignment_lost");
        expect(row.settled_at).not.toBeNull();
      },
      { timeout: 5000, interval: 20 },
    );
  });

  it("does not let a full page of pending mailbox inputs starve later control requests", async () => {
    const host = controller(),
      fact = start("waiting-page");
    await consume(host, fact);
    const child = (await response(fact.factId)).result!;
    const pending = Array.from({ length: 129 }, () =>
      command(
        {
          action: "send",
          target: child.executionId as string,
          message: "queued input",
          delivery: "notify",
        },
        fact.workflowId,
      ),
    );
    await db
      .insertInto("subagent_control_commands")
      .values(
        pending.map((c) => ({
          id: c.factId,
          tenant_id: tenantId,
          run_id: runId,
          partition: 0,
          command: c as unknown as Record<string, unknown>,
          delivered_at: null,
          input_consumed_at: null,
        })),
      )
      .execute();
    const status = command(
      { action: "status", target: child.executionId as string },
      fact.workflowId,
    );
    await consume(host, status);
    expect((await response(status.factId)).result?.state).toBe("queued");
    expect(pending.every((c) => !results.has(c.factId))).toBe(true);
  }, 20000);
});
