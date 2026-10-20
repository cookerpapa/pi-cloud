import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { createExecutionReference, type ConversationStartRequest } from "@pi-cloud/protocol";
import type {
  AcceptedControlToolCommand,
  AcceptedDurableCommitFact,
} from "@pi-cloud/runtime-core/accepted-fact";
import {
  DurablePostgresProjection,
  type StoredDurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { sql } from "kysely";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

/** Real PG resource/native read-model fixture. Execution/ownership behavior is
 * tested with the real Harness separately; these writes model its public records. */
export async function nativeSubagentFixture() {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  const admin = endpoint
    ? createDatabase({ connectionString: endpoint, maxConnections: 1 })
    : undefined;
  const name = `native_children_${crypto.randomUUID().replaceAll("-", "")}`;
  let pg: PGlite | undefined, socket: PGLiteSocketServer | undefined, url: string;
  if (admin) {
    await sql`create database ${sql.id(name)}`.execute(admin);
    const parsed = new URL(endpoint!);
    parsed.pathname = `/${name}`;
    url = parsed.toString();
  } else {
    pg = await PGlite.create();
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
    await socket.start();
    url = `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`;
  }
  const database = createDatabase({ connectionString: url, maxConnections: admin ? 6 : 1 });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "native-children",
    ownerDisplayName: "Native fixture",
  });
  await database
    .insertInto("sandbox_domains")
    .values({
      id: "sandbox-domain-native-fixture",
      display_name: "Fixture",
      state: "active",
      sandbox_control_base_url: "http://fixture.invalid",
      workspace_storage_key: "fixture",
      maximum_active_sandboxes: 32,
    })
    .execute();
  const store = new ControlPlaneStore({ database, ...tenant });
  const project = await store.createProject({ name: "Native children", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Parent",
    "elastic",
  );
  const accepted = await store.acceptTurn(session.sessionId, "root", { prompt: "Delegate" });
  const workerId = crypto.randomUUID(),
    writerId = crypto.randomUUID();
  await database
    .insertInto("workers")
    .values({
      id: workerId,
      supervisor_id: "fixture",
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: 1,
    })
    .execute();
  await database
    .updateTable("runs")
    .set({
      state: "running",
      worker_id: workerId,
      lease_id: writerId,
      fencing_token: 1,
      started_at: new Date(),
    })
    .where("id", "=", accepted.runId)
    .execute();
  await database
    .insertInto("session_leases")
    .values({
      tenant_id: tenant.tenantId,
      pi_session_id: session.sessionId,
      lease_id: writerId,
      worker_id: workerId,
      fencing_token: 1,
      valid_until: new Date(Date.now() + 3_600_000),
    })
    .execute();
  await database
    .updateTable("pi_sessions")
    .set({ lease_epoch: 1 })
    .where("tenant_id", "=", tenant.tenantId)
    .where("id", "=", session.sessionId)
    .execute();
  const scope = {
    tenantId: tenant.tenantId,
    piSessionId: session.sessionId,
    sessionId: session.sessionId,
    turnId: accepted.turnId,
    runId: accepted.runId,
    writerId,
    fencingToken: 1,
  };
  const reference = createExecutionReference(writerId, accepted.runId, 1);
  await database
    .updateTable("runs")
    .set({ output_publication: { scope: { ...scope, leaseId: writerId, piConversationId: 1 } } })
    .where("id", "=", accepted.runId)
    .execute();
  const projection = new DurablePostgresProjection(database, {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
  });
  let nextId = 2;
  let publish: ((fact: AcceptedDurableCommitFact) => Promise<void>) | undefined;
  const append = async (
    writes: Record<string, unknown>[],
    view = { sessionId: scope.sessionId, turnId: scope.turnId },
    metadata?: { controlTools: AcceptedDurableCommitFact["tools"] },
  ) => {
    const seq = (await projection.head()).seq + 1;
    const commit = { seq, nextId, writes };
    const origins = writes.flatMap((write) => {
      const value = write.value as { id?: number; conversationId?: number } | undefined;
      return value?.id !== undefined && value.conversationId !== undefined
        ? [
            {
              recordId: value.id,
              sessionId: view.sessionId,
              turnId: view.turnId,
              runId: scope.runId,
            },
          ]
        : [];
    });
    if (publish)
      await publish({
        kind: "durable_commit",
        factId: crypto.randomUUID(),
        scope,
        commit,
        origins,
        display: [],
        tools: metadata?.controlTools ?? [],
        cancellations: [],
        occurredAt: new Date().toISOString(),
      });
    else
      await projection.apply(
        commit as unknown as StoredDurableBatch,
        origins,
        { topic: "fixture", partition: 0, offset: BigInt(seq) },
        metadata,
      );
    return seq;
  };
  await append([{ type: "conversation", value: { id: 1 } }]);
  const command = async (
    args: Record<string, unknown>,
    view?: { sessionId: string; turnId: string; conversationId: number },
    name: AcceptedControlToolCommand["toolName"] = "action" in args
      ? "subagent_control"
      : "subagent",
  ) => {
    const taskId = nextId++;
    const call = {
      kind: "control_tool",
      target: "control",
      operationId: crypto.randomUUID(),
      taskId,
      conversationId: view?.conversationId ?? 1,
      toolName: name,
      contextAnchor: null,
      replyTopic: "fixture-boot",
      scope: { ...scope, ...(view ? { sessionId: view.sessionId, turnId: view.turnId } : {}) },
      arguments: args,
      nativeCallId: `provider-${taskId}`,
      nativeSequence: 0,
    } satisfies AcceptedControlToolCommand;
    const {
      kind: _kind,
      arguments: _args,
      nativeCallId: _call,
      nativeSequence: _seq,
      ...dispatch
    } = call;
    call.nativeSequence = await append(
      [
        {
          type: "task",
          value: {
            id: taskId,
            conversationId: view?.conversationId ?? 1,
            kind: "pi.tool",
            version: 1,
            input: { assistant: 1, callId: `provider-${taskId}` },
            background: false,
            abortRequested: false,
            state: {
              status: "running",
              checkpoint: {
                phase: "execute",
                arguments: args,
                replay: name === "subagent" ? "safe" : "unsafe",
              },
            },
          },
        },
      ],
      view,
      { controlTools: [dispatch] },
    );
    return call;
  };
  const children = new Map<
    string,
    {
      request: ConversationStartRequest;
      conversationId: number;
      taskId: number;
      inputId: number;
      userId: number;
    }
  >();
  const start = async (request: ConversationStartRequest) => {
    const existing = children.get(request.view.id);
    if (existing) return existing.conversationId;
    const conversationId = nextId++,
      userId = nextId++,
      inputId = nextId++,
      taskId = nextId++;
    await append(
      [
        {
          type: "conversation",
          value: {
            id: conversationId,
            owner: {
              conversationId: request.view.parentConversationId,
              taskId: request.view.ownerTaskId,
            },
          },
        },
        {
          type: "entry",
          value: {
            id: userId,
            conversationId,
            kind: "pi.user",
            model: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
          },
        },
        {
          type: "submission",
          value: {
            id: inputId,
            conversationId,
            type: "input",
            requestId: scope.runId,
            status: "placed",
            entry: userId,
          },
        },
        {
          type: "task",
          value: {
            id: taskId,
            conversationId,
            kind: "pi.generation",
            version: 1,
            input: {},
            background: false,
            abortRequested: false,
            state: { status: "running", checkpoint: { phase: "request" } },
          },
        },
      ],
      request.view,
    );
    children.set(request.view.id, { request, conversationId, taskId, inputId, userId });
    return conversationId;
  };
  const settle = async (
    id: string,
    outcome: "completed" | "cancelled" | "failed" | "completing" = "completed",
    text = "Child answer",
  ) => {
    const child = children.get(id)!;
    const answerId = nextId++;
    await append(
      [
        {
          type: "entry",
          value: {
            id: answerId,
            conversationId: child.conversationId,
            kind: "pi.assistant",
            model: [fauxAssistantMessage(text)],
          },
        },
        {
          type: "submission",
          value: {
            id: child.inputId,
            conversationId: child.conversationId,
            type: "input",
            requestId: scope.runId,
            entry: child.userId,
            ...(outcome === "failed" || outcome === "cancelled"
              ? { status: "unanswered", reason: outcome === "cancelled" ? "aborted" : "error" }
              : { status: "done", answer: answerId }),
          },
        },
        {
          type: "task",
          value: {
            id: child.taskId,
            conversationId: child.conversationId,
            kind: "pi.generation",
            version: 1,
            input: {},
            background: false,
            abortRequested: outcome === "cancelled",
            state: {
              status: outcome === "completing" ? "completing" : "terminal",
              outcome: { status: outcome === "cancelled" ? "aborted" : "completed", value: null },
            },
          },
        },
      ],
      child.request.view,
    );
  };
  const finishCall = async (call: AcceptedControlToolCommand) => {
    const current = await sql<{ body: string }>`select l.body from pi_durable_records r
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.piSessionId} and r.id=${call.taskId}`.execute(
      database,
    );
    const value = JSON.parse(current.rows[0]!.body).value;
    value.state = { status: "terminal", outcome: { status: "completed", value: null } };
    await append([{ type: "task", value }], call.scope);
  };
  return {
    database,
    url,
    tenant,
    store,
    project,
    scope,
    reference,
    projection,
    append,
    command,
    children,
    allocateId: () => nextId++,
    setPublisher(callback: (fact: AcceptedDurableCommitFact) => Promise<void>) {
      publish = callback;
    },
    native: {
      start,
      stop: async (_reference: string, id: string) => {
        await settle(id, "cancelled");
      },
    },
    settle,
    finishCall,
    async close() {
      await database.destroy();
      await socket?.stop();
      await pg?.close();
      if (admin) {
        await sql`drop database ${sql.id(name)}`.execute(admin);
        await admin.destroy();
      }
    },
  };
}
