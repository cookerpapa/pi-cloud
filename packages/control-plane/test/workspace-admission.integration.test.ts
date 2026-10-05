import {
  copyDurableHistory,
  readDurableEntries,
  forkIdleConversation,
} from "@pi-cloud/pi-session-postgres/durable";
import { appendNativeFixture } from "./fixtures/durable-native.ts";
import { PostgresDurableCommitProjector } from "../../runtime-core/src/postgres-durable-commit-projector.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely, type QueryId } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConversationDeletionService,
  ControlPlaneStore,
  createPrivateTenant,
} from "../src/index.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";

const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

// PGlite shares a single backend and cannot exercise independent row-lock owners.
// CI supplies real PostgreSQL; use a disposable database, never its application tables.
describe.skipIf(connectionString === undefined)("Workspace deletion / message admission", () => {
  const databaseName = `workspace_admission_${randomUUID().replaceAll("-", "")}`;
  let administrator: Kysely<Database>;
  let database: Kysely<Database>;
  let store: ControlPlaneStore;
  let scope: { tenantId: string; defaultModelProfileId: string; ownerUserId: string };

  beforeAll(async () => {
    administrator = createDatabase({ connectionString: connectionString!, maxConnections: 1 });
    await sql`create database ${sql.id(databaseName)}`.execute(administrator);
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    url.searchParams.set("application_name", databaseName);
    url.searchParams.set(
      "options",
      "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
    );
    database = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
    await runMigrations(database, "up");
    scope = await createPrivateTenant(database, {
      slug: "workspace-admission",
      ownerDisplayName: "Workspace admission test",
    });
    store = new ControlPlaneStore({ database, ...scope });
  }, 60_000);

  afterAll(async () => {
    await database?.destroy();
    if (administrator) {
      await sql`drop database if exists ${sql.id(databaseName)}`.execute(administrator);
      await administrator.destroy();
    }
  });

  async function fixture(name: string) {
    const project = await store.createProject({ name, source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      name,
      "elastic",
      { ownerUserId: scope.ownerUserId },
    );
    return { project, session };
  }

  async function machineFixture(ownerUserId = scope.ownerUserId) {
    const project = await store.createProject({
      name: `machine-${randomUUID()}`,
      source: { kind: "empty" },
    });
    const workspace = await database
      .updateTable("workspaces")
      .set({ workspace_kind: "development_environment" })
      .where("id", "=", project.workspaceId)
      .returning("sandbox_domain_id")
      .executeTakeFirstOrThrow();
    const instanceId = randomUUID(),
      environmentId = randomUUID(),
      baseUrl = `http://broker-${instanceId}:4000`;
    await database
      .insertInto("sandbox_control_instances")
      .values({
        instance_id: instanceId,
        sandbox_domain_id: workspace.sandbox_domain_id,
        owner_base_url: baseUrl,
        state: "ready",
        lease_expires_at: new Date(Date.now() + 60000),
        last_heartbeat_at: new Date(),
      })
      .execute();
    await database
      .insertInto("development_environments")
      .values({
        id: environmentId,
        tenant_id: scope.tenantId,
        owner_user_id: ownerUserId,
        project_id: project.projectId,
        workspace_id: project.workspaceId,
        sandbox_domain_id: workspace.sandbox_domain_id,
        environment_version_id: project.environment.environmentVersionId,
        owner_instance_id: instanceId,
        owner_base_url: baseUrl,
        runtime_id: `runtime-${environmentId}`,
        runtime_name: `runtime-${environmentId}`,
        state: "running",
        idempotency_key: environmentId,
        request_sha256: "a".repeat(64),
        profile_key: "starter",
        cpu_count: 1,
        memory_mib: 2048,
        system_disk_gib: 8,
      })
      .execute();
    return { ...project, environmentId };
  }

  it("binds a missing Workspace to its owner's machine without changing history identity or accepted Runs", async () => {
    const { project, session } = await fixture("machine-rebind");
    const accepted = await store.acceptTurn(session.sessionId, "old-workspace-input", {
      prompt: "queued input",
    });
    const queue = new QueuedInputService({
      database,
      steering: {
        async deliverQueued() {
          throw new Error("No steer expected");
        },
      },
    });
    await queue.mutate(scope.tenantId, session.sessionId, accepted.turnId, "cancel-old-input", {
      action: "cancel",
      revision: (await queue.list(scope.tenantId, session.sessionId)).revision,
    });
    const before = await database
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    await store.deleteWorkspace(project.workspaceId, "remove-for-machine");
    const machine = await machineFixture();
    const execution = {
      ownerUserId: scope.ownerUserId,
      workingDirectory: "/home/user/rebound-project",
    };
    const result = await store.rebindConversationWorkspace(
      session.sessionId,
      machine.workspaceId,
      "bind-machine",
      execution,
    );
    expect(
      await store.rebindConversationWorkspace(
        session.sessionId,
        machine.workspaceId,
        "bind-machine",
        execution,
      ),
    ).toEqual({ ...result, replayed: true });
    await expect(
      store.rebindConversationWorkspace(session.sessionId, machine.workspaceId, "bind-machine", {
        ...execution,
        workingDirectory: "/home/user/another",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const after = await database
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      execution_mode: "development_environment",
      development_environment_id: machine.environmentId,
      workspace_id: machine.workspaceId,
      project_id: machine.projectId,
      sandbox_profile_key: "starter",
      working_directory: execution.workingDirectory,
      pi_session_id: before.pi_session_id,
      desired_model_profile_id: before.desired_model_profile_id,
      desired_thinking_level: before.desired_thinking_level,
      created_by_user_id: before.created_by_user_id,
      agent_revision_id: before.agent_revision_id,
    });
    expect((await store.getRun(accepted.runId)).workspaceId).toBe(project.workspaceId);
    const next = await store.acceptTurn(session.sessionId, "new-machine-input", {
      prompt: "continue",
    });
    expect(
      await database
        .selectFrom("runs")
        .select(["workspace_id", "working_directory", "sandbox_profile_key"])
        .where("id", "=", next.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      workspace_id: machine.workspaceId,
      working_directory: execution.workingDirectory,
      sandbox_profile_key: "starter",
    });
  });

  it("rejects foreign machine owners, invalid directories, unavailable targets and live Workspace changes", async () => {
    const { project, session } = await fixture("machine-rebind-guards");
    const foreignUserId = randomUUID();
    await database
      .insertInto("users")
      .values({ id: foreignUserId, tenant_id: scope.tenantId, display_name: "Other" })
      .execute();
    const machine = await machineFixture(foreignUserId);
    const rebind = (ownerUserId = scope.ownerUserId, workingDirectory = "/home/user") =>
      store.rebindConversationWorkspace(session.sessionId, machine.workspaceId, randomUUID(), {
        ownerUserId,
        workingDirectory,
      });
    await expect(rebind()).rejects.toMatchObject({ code: "conflict" });
    await store.deleteWorkspace(project.workspaceId, "delete-rebind-guards");
    await database
      .updateTable("sessions")
      .set({ state: "running" })
      .where("id", "=", session.sessionId)
      .execute();
    await expect(rebind()).rejects.toMatchObject({ code: "conflict" });
    await database
      .updateTable("sessions")
      .set({ state: "idle" })
      .where("id", "=", session.sessionId)
      .execute();
    await expect(rebind()).rejects.toMatchObject({ code: "not_found" });
    await expect(rebind(foreignUserId)).rejects.toMatchObject({ code: "not_found" });
    await expect(rebind(scope.ownerUserId, "relative/path")).rejects.toMatchObject({
      code: "invalid_request",
    });
    const foreign = await createPrivateTenant(database, {
      slug: `foreign-${randomUUID()}`,
      ownerDisplayName: "Foreign",
    });
    const foreignTarget = await new ControlPlaneStore({
      database,
      tenantId: foreign.tenantId,
      defaultModelProfileId: foreign.defaultModelProfileId,
    }).createProject({ name: "Foreign Workspace", source: { kind: "empty" } });
    await expect(
      store.rebindConversationWorkspace(
        session.sessionId,
        foreignTarget.workspaceId,
        randomUUID(),
        { ownerUserId: scope.ownerUserId },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await database
      .updateTable("development_environments")
      .set({ owner_user_id: scope.ownerUserId, state: "unknown" })
      .where("id", "=", machine.environmentId)
      .execute();
    await expect(rebind()).rejects.toMatchObject({ code: "conflict" });
    await database
      .updateTable("development_environments")
      .set({
        state: "released",
        runtime_id: null,
        runtime_name: null,
        owner_instance_id: null,
        owner_base_url: null,
        released_at: new Date(),
      })
      .where("id", "=", machine.environmentId)
      .execute();
    await expect(rebind()).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getConversation(session.sessionId)).session.workspaceState).toBe("missing");
  });

  it("rejects a machine rebind if release intent commits while its row lock is awaited", async () => {
    const { project, session } = await fixture("machine-rebind-release-race");
    await store.deleteWorkspace(project.workspaceId, "delete-release-race");
    const machine = await machineFixture();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const lifecycle = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom("development_environments")
        .select("id")
        .where("id", "=", machine.environmentId)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
      await tx
        .insertInto("development_environment_operations")
        .values({
          id: randomUUID(),
          tenant_id: scope.tenantId,
          environment_id: machine.environmentId,
          actor_user_id: scope.ownerUserId,
          idempotency_key: "pending-release",
          action: "release",
          request_sha256: "b".repeat(64),
          result_state: "running",
        })
        .execute();
    });
    await locked.promise;
    const binding = store
      .rebindConversationWorkspace(session.sessionId, machine.workspaceId, "racing-bind", {
        ownerUserId: scope.ownerUserId,
      })
      .catch((error) => error);
    try {
      await waitForContender();
    } finally {
      release.resolve();
    }
    await lifecycle;
    expect(await binding).toMatchObject({
      code: "conflict",
      message: "Cloud development machine is being released",
    });
    expect((await store.getConversation(session.sessionId)).session.workspaceState).toBe("missing");
  });

  it("allows paused owned targets but blocks new work until resume", async () => {
    const { project, session } = await fixture("machine-rebind-paused");
    await store.deleteWorkspace(project.workspaceId, "delete-paused");
    const machine = await machineFixture();
    await database
      .updateTable("development_environments")
      .set({ state: "paused" })
      .where("id", "=", machine.environmentId)
      .execute();
    await store.rebindConversationWorkspace(session.sessionId, machine.workspaceId, "bind-paused", {
      ownerUserId: scope.ownerUserId,
    });
    expect((await store.getConversation(session.sessionId)).session.workingDirectory).toBe(
      "/home/user",
    );
    await expect(
      store.acceptTurn(session.sessionId, "paused-input", { prompt: "wait" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  function pauseAfterInsert(table: string) {
    let notifyWaiting!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = new WeakSet<QueryId>();
    // Run insertion now completes in the input/Run/mailbox statement, not an
    // independently executed INSERT whose builder also has a query ID.
    const prefix = table === "runs" ? 'with "accepted_turn"' : `insert into "${table}"`;
    const paused = database.withPlugin({
      transformQuery({ node, queryId }) {
        const query = database.getExecutor().compileQuery(node, queryId);
        if (query.sql.startsWith(prefix)) selected.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (selected.has(queryId)) {
          notifyWaiting();
          await released;
        }
        return result;
      },
    });
    return {
      store: new ControlPlaneStore({ database: paused, ...scope }),
      waiting,
      release,
    };
  }

  async function waitForContender() {
    await vi.waitFor(
      async () => {
        const result = await sql<{ count: string }>`
        select count(*)::text as count from pg_stat_activity
        where application_name = ${databaseName} and wait_event_type = 'Lock'
      `.execute(database);
        expect(Number(result.rows[0]!.count)).toBeGreaterThan(0);
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  it("replays a concurrent Workspace rebind after the first request changes the binding", async () => {
    const { project, session } = await fixture("rebind-replay");
    const target = await store.createProject({ name: "rebind-target", source: { kind: "empty" } });
    await store.deleteWorkspace(project.workspaceId, "remove-original");
    const paused = pauseAfterInsert("conversation_workspace_rebind_operations");
    const first = paused.store.rebindConversationWorkspace(
      session.sessionId,
      target.workspaceId,
      "same-rebind",
    );
    let replay: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      replay = store
        .rebindConversationWorkspace(session.sessionId, target.workspaceId, "same-rebind")
        .then(
          (value) => value,
          (error) => ({ rejected: error }),
        );
      await waitForContender();
    } finally {
      paused.release();
    }
    const original = await first;
    expect(await replay).toEqual({ ...original, replayed: true });
    await expect(
      store.rebindConversationWorkspace(session.sessionId, project.workspaceId, "same-rebind"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("replays cancellation already accepted by a concurrent request", async () => {
    const { session } = await fixture("cancel-replay");
    const turn = await store.acceptTurn(session.sessionId, "message", { prompt: "cancel me" });
    await database
      .updateTable("sessions")
      .set({ state: "running" })
      .where("id", "=", session.sessionId)
      .execute();
    await database
      .updateTable("turns")
      .set({ state: "running" })
      .where("id", "=", turn.turnId)
      .execute();
    await database
      .updateTable("runs")
      .set({ state: "running" })
      .where("id", "=", turn.runId)
      .execute();
    const paused = pauseAfterInsert("turn_control_requests");
    const first = paused.store.acceptTurnCancellation(
      session.sessionId,
      turn.turnId,
      "same-cancel",
      {},
    );
    let replay: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      replay = store.acceptTurnCancellation(session.sessionId, turn.turnId, "same-cancel", {}).then(
        (value) => value,
        (error) => ({ rejected: error }),
      );
      await waitForContender();
    } finally {
      paused.release();
    }
    const original = await first;
    expect(await replay).toEqual({ ...original, replayed: true });
    await expect(
      store.acceptTurnCancellation(session.sessionId, turn.turnId, "same-cancel", {
        gracePeriodMs: 1234,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects a message if concurrent deletion commits after its Workspace lookup begins", async () => {
    const { project, session } = await fixture("deletion-first");
    const paused = pauseAfterInsert("workspace_delete_operations");
    const deletion = paused.store.deleteWorkspace(project.workspaceId, "delete-first");
    let admission: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      admission = store
        .acceptTurn(session.sessionId, "racing-message", { prompt: "do not lose me" })
        .then(
          (value) => ({ accepted: value }),
          (error) => ({ rejected: error }),
        );
      await waitForContender();
    } finally {
      paused.release();
    }
    await deletion;
    expect(await admission).toMatchObject({ rejected: { code: "conflict" } });
    expect(
      await database
        .selectFrom("turns")
        .select("id")
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(0);
  });

  it("lets admitted work prevent deletion without taking an exclusive Workspace lock", async () => {
    const { project, session } = await fixture("admission-first");
    const paused = pauseAfterInsert("runs");
    const admission = paused.store.acceptTurn(session.sessionId, "accept-first", {
      prompt: "keep me",
    });
    let deletion: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      // Another Session may perform its own admission check concurrently.
      await database.transaction().execute(async (transaction) => {
        await sql`select id from workspaces where id = ${project.workspaceId} for share nowait`.execute(
          transaction,
        );
      });
      deletion = store.deleteWorkspace(project.workspaceId, "delete-second").then(
        (value) => ({ deleted: value }),
        (error) => ({ rejected: error }),
      );
      await waitForContender();
    } finally {
      paused.release();
    }
    const accepted = await admission;
    expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "state"])
        .where("id", "=", accepted.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: accepted.runId, state: "queued" });
    expect(
      await database
        .selectFrom("workspaces")
        .select("deleted_at")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: null });
  });

  it("does not delete a child whose message commits while its parent is being deleted", async () => {
    const { project, session: parent } = await fixture("parent-delete");
    const anchor = await store.acceptTurn(parent.sessionId, "anchor", { prompt: "prior turn" });
    await database
      .updateTable("runs")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", anchor.runId)
      .execute();
    await database
      .updateTable("turns")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", anchor.turnId)
      .execute();
    const child = await store.createSession(
      project.projectId,
      project.workspaceId,
      "child",
      "elastic",
    );
    await database
      .updateTable("sessions")
      .set({
        conversation_parent_session_id: parent.sessionId,
        conversation_fork_turn_id: anchor.turnId,
        conversation_fork_entry_id: randomUUID(),
      })
      .where("id", "=", child.sessionId)
      .execute();
    const paused = pauseAfterInsert("runs");
    const admission = paused.store.acceptTurn(child.sessionId, "child-message", {
      prompt: "keep this task",
    });
    let deletion: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      deletion = new ConversationDeletionService({ database })
        .delete(scope.tenantId, parent.sessionId)
        .then(
          (value) => ({ deleted: value }),
          (error) => ({ rejected: error }),
        );
      expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    } finally {
      paused.release();
    }
    await admission;
    expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    const sessions = await database
      .selectFrom("sessions")
      .select("pruned_at")
      .where("id", "in", [parent.sessionId, child.sessionId])
      .execute();
    expect(sessions).toEqual([{ pruned_at: null }, { pruned_at: null }]);
  });

  it("rejects deletion if the descendant tree grows while child locks are being acquired", async () => {
    const { project, session: parent } = await fixture("growing-tree");
    const anchor = await store.acceptTurn(parent.sessionId, "anchor", { prompt: "prior turn" });
    await database
      .updateTable("runs")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", anchor.runId)
      .execute();
    await database
      .updateTable("turns")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", anchor.turnId)
      .execute();
    const child = await store.createSession(
      project.projectId,
      project.workspaceId,
      "branch",
      "elastic",
    );
    const grandchild = await store.createSession(
      project.projectId,
      project.workspaceId,
      "new branch",
      "elastic",
    );
    const link = (parentId: string) => ({
      conversation_parent_session_id: parentId,
      conversation_fork_turn_id: anchor.turnId,
      conversation_fork_entry_id: randomUUID(),
    });
    await database
      .updateTable("sessions")
      .set(link(parent.sessionId))
      .where("id", "=", child.sessionId)
      .execute();
    let notifyReady!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const growth = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", child.sessionId)
        .forUpdate()
        .execute();
      await transaction
        .updateTable("sessions")
        .set(link(child.sessionId))
        .where("id", "=", grandchild.sessionId)
        .execute();
      notifyReady();
      await released;
    });
    let deletion: Promise<unknown> | undefined;
    try {
      await ready;
      deletion = new ConversationDeletionService({ database })
        .delete(scope.tenantId, parent.sessionId)
        .then(
          (value) => ({ deleted: value }),
          (error) => ({ rejected: error }),
        );
      expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    } finally {
      release();
    }
    await growth;
    expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    expect(
      await database
        .selectFrom("sessions")
        .select("pruned_at")
        .where("id", "in", [parent.sessionId, child.sessionId, grandchild.sessionId])
        .execute(),
    ).toEqual([{ pruned_at: null }, { pruned_at: null }, { pruned_at: null }]);
    // Retrying against the new stable tree deletes every descendant.
    await new ConversationDeletionService({ database }).delete(scope.tenantId, parent.sessionId);
    expect(
      await database
        .selectFrom("sessions")
        .select("id")
        .where("id", "in", [parent.sessionId, child.sessionId, grandchild.sessionId])
        .where("pruned_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  });
  it("erases owned history and references atomically while retaining independent native copies and Workspace bytes", async () => {
    const { project, session } = await fixture("permanent-history");
    const nativeScope = { tenantId: scope.tenantId, sessionId: session.sessionId };
    const entry = (
      await appendNativeFixture(database, nativeScope, [
        { kind: "pi.user", model: [{ role: "user", content: "private-history", timestamp: 1 }] },
      ])
    )[0]!;
    const independentId = randomUUID();
    await database
      .insertInto("pi_sessions")
      .values({
        tenant_id: scope.tenantId,
        id: independentId,
        created_at_ms: Date.now(),
        name: null,
        parent_session_id: null,
      })
      .execute();
    await database
      .transaction()
      .execute(async (tx) =>
        copyDurableHistory(
          tx,
          { tenantId: scope.tenantId, sessionId: independentId },
          (
            await readDurableEntries(tx, { ...nativeScope, conversationId: 1, limit: 100 })
          ).reverse(),
        ),
      );
    const otherTenant = await createPrivateTenant(database, {
      slug: randomUUID(),
      ownerDisplayName: "Other",
    });
    await database
      .insertInto("pi_sessions")
      .values({
        tenant_id: otherTenant.tenantId,
        id: session.sessionId,
        created_at_ms: Date.now(),
        name: null,
        parent_session_id: null,
      })
      .execute();
    const childConversation = await database
      .transaction()
      .execute((tx) => forkIdleConversation(tx, nativeScope, 1, entry.id));
    const logicalId = randomUUID();
    const row = await database
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("sessions")
      .values({
        ...row,
        tool_capabilities: sql`${JSON.stringify(row.tool_capabilities)}::jsonb`,
        id: logicalId,
        session_kind: "subagent",
        pi_conversation_id: String(childConversation),
      })
      .execute();
    const imageId = randomUUID();
    await sql`insert into session_image_objects(tenant_id,id,state,sha256,byte_length,mime_type)
      values(${scope.tenantId}::uuid,${imageId}::uuid,'ready',${"a".repeat(64)},1,'image/png')`.execute(
      database,
    );
    await sql`insert into session_image_references(tenant_id,session_id,image_id)
      values(${scope.tenantId}::uuid,${session.sessionId},${imageId}::uuid),
        (${scope.tenantId}::uuid,${independentId},${imageId}::uuid)`.execute(database);
    await database
      .insertInto("session_uploads")
      .values({
        id: randomUUID(),
        tenant_id: scope.tenantId,
        session_id: session.sessionId,
        pi_session_id: session.sessionId,
        workspace_id: project.workspaceId,
        actor_user_id: scope.ownerUserId,
        working_directory: "/workspace",
        name: "pending.txt",
        path: "/workspace/pending.txt",
        mime_type: "text/plain",
        byte_length: "1",
        sha256: "a".repeat(64),
        state: "uploading",
        claim_token: randomUUID(),
        lease_expires_at: new Date(Date.now() + 60000),
        image_reference: null,
        accepted_at: null,
        expires_at: new Date(Date.now() + 60000),
      })
      .execute();
    const accepted = await store.acceptTurn(session.sessionId, "history", {
      prompt: "private input",
    });
    const sealId = randomUUID();
    await database
      .updateTable("runs")
      .set({
        state: "completed",
        settled_at: new Date(),
        output_seal_id: sealId,
        output_sealed_at: new Date(),
      })
      .where("id", "=", accepted.runId)
      .execute();
    await database
      .updateTable("turns")
      .set({ state: "completed", settled_at: new Date() })
      .where("id", "=", accepted.turnId)
      .execute();
    await database
      .insertInto("outbox")
      .values({
        id: sealId,
        tenant_id: scope.tenantId,
        aggregate_type: "session_terminal_event",
        aggregate_id: sealId,
        topic: "session.event.accepted.v1",
        payload: { private: "terminal" },
        published_at: null,
        last_error: null,
      })
      .execute();
    const deletion = new ConversationDeletionService({ database });
    // Public identity is tenant-scoped, including idempotent absent results.
    await deletion.delete(otherTenant.tenantId, session.sessionId);
    expect(
      (await readDurableEntries(database, { ...nativeScope, conversationId: 1, limit: 1 }))[0]
        ?.entry,
    ).toEqual(entry);
    await deletion.delete(scope.tenantId, session.sessionId);
    await deletion.delete(scope.tenantId, session.sessionId);
    for (const table of ["sessions", "turns", "runs"] as const) {
      const count =
        table === "sessions"
          ? await database
              .selectFrom(table)
              .select("id")
              .where("id", "in", [session.sessionId, logicalId])
              .execute()
          : await database
              .selectFrom(table)
              .select("id")
              .where("session_id", "=", session.sessionId)
              .execute();
      expect(count).toEqual([]);
    }
    for (const table of [
      "pi_sessions",
      "pi_durable_log",
      "pi_durable_records",
      "pi_durable_commits",
      "pi_durable_document_revisions",
      "session_image_references",
    ] as const) {
      const rows =
        await sql`select 1 from ${sql.table(table)} where tenant_id=${scope.tenantId}::uuid
        and ${sql.ref(table === "pi_sessions" ? "id" : "session_id")}=${session.sessionId}`.execute(
          database,
        );
      expect(rows.rows).toEqual([]);
    }
    expect(
      await database
        .selectFrom("session_uploads")
        .select("id")
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("outbox").select("id").where("id", "=", sealId).execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("workspaces")
        .select("deleted_at")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: null });
    expect(
      (
        await readDurableEntries(database, {
          tenantId: scope.tenantId,
          sessionId: independentId,
          conversationId: 1,
          limit: 100,
        })
      ).map((row) => row.entry),
    ).toEqual([entry]);
    expect(
      (
        await sql`select 1 from session_image_references where image_id=${imageId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", otherTenant.tenantId)
        .where("id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(1);
    // A retained Kafka record can be consumed again without recreating a Run/log.
    await new PostgresDurableCommitProjector(database).project(
      {
        kind: "durable_commit",
        factId: randomUUID(),
        scope: {
          tenantId: scope.tenantId,
          sessionId: session.sessionId,
          turnId: accepted.turnId,
          runId: accepted.runId,
          fencingToken: 1,
          piSessionId: session.sessionId,
          writerId: randomUUID(),
        },
        commit: { seq: 1, nextId: entry.id + 1, writes: [{ type: "entry", value: entry }] },
        origins: [],
        tools: [],
        cancellations: [],
        events: [],
        occurredAt: new Date().toISOString(),
      },
      { topic: "retained-history", partition: 0, offset: 100n },
    );
    expect(
      await database
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", scope.tenantId)
        .where("id", "=", session.sessionId)
        .execute(),
    ).toEqual([]);
  });

  it("rolls deletion back for unsealed output or a current native writer, even after its lease time", async () => {
    const { session } = await fixture("delete-authority");
    const worker = await createTestWorker(database);
    const leaseId = randomUUID();
    const deletion = new ConversationDeletionService({ database });
    await database
      .insertInto("session_leases")
      .values({
        tenant_id: scope.tenantId,
        pi_session_id: session.sessionId,
        lease_id: leaseId,
        sandbox_id: worker.workerId,
        fencing_token: "1",
        acquired_at: new Date(Date.now() - 60000),
        valid_until: new Date(Date.now() - 1000),
        released_at: null,
        writer_failed_at: null,
        writer_sealed_at: null,
        writer_seal_offset: null,
      })
      .execute();
    await expect(deletion.delete(scope.tenantId, session.sessionId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await database
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(1);
    await database
      .updateTable("session_leases")
      .set({ released_at: new Date() })
      .where("lease_id", "=", leaseId)
      .execute();
    await database
      .updateTable("pi_sessions")
      .set({ unsealed_runs: "1" })
      .where("tenant_id", "=", scope.tenantId)
      .where("id", "=", session.sessionId)
      .execute();
    await expect(deletion.delete(scope.tenantId, session.sessionId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await database
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(1);
    await database
      .updateTable("pi_sessions")
      .set({ unsealed_runs: "0" })
      .where("tenant_id", "=", scope.tenantId)
      .where("id", "=", session.sessionId)
      .execute();
    await deletion.delete(scope.tenantId, session.sessionId);
    expect(
      await database
        .selectFrom("session_leases")
        .select("lease_id")
        .where("lease_id", "=", leaseId)
        .execute(),
    ).toEqual([]);
  });
});
