import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { nativeSubagentFixture } from "../../control-plane/test/native-subagent-fixture.ts";
import { PostgresSubagentConversations } from "../../subagent-control/src/postgres-subagent-conversations.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../src/workspace-runtime-state-repository.ts";
import { SandboxController } from "../src/sandbox-controller.ts";
import { CUBESANDBOX_TOOL_POLICY } from "../src/cubesandbox-sandbox-provider.ts";
import type { SandboxProvider, SandboxHandle } from "../src/sandbox-provider.ts";
import { InMemorySandboxBindings } from "./helpers/in-memory-sandbox-bindings.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import {
  parseEnvironmentRuntimeSnapshot,
  parseEnvironmentValidationReport,
  type ToolSandboxCreateRequest,
} from "../../protocol/src/index.ts";

// Shared compute lifetime regressions with actual PG admission/recovery methods.
// Physical effects are controlled; no model, live VM or production mutation.
async function fixture(afterRepositoryQuery?: (query: string) => Promise<void>) {
  if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
    throw new Error("Run through scripts/run-with-test-postgres.mjs");
  const f = await nativeSubagentFixture();
  const domain = await f.database
    .selectFrom("workspaces")
    .select("sandbox_domain_id")
    .where("id", "=", f.project.workspaceId)
    .executeTakeFirstOrThrow();
  const statements = new WeakMap<object, string>();
  const database = afterRepositoryQuery
    ? f.database.withPlugin({
        transformQuery({ node, queryId }) {
          statements.set(queryId, f.database.getExecutor().compileQuery(node, queryId).sql);
          return node;
        },
        async transformResult({ queryId, result }) {
          await afterRepositoryQuery(statements.get(queryId) ?? "");
          return result;
        },
      })
    : f.database;
  const repo = new PostgresWorkspaceRuntimeStateRepository({
    database,
    instanceId: randomUUID(),
    sandboxDomainId: domain.sandbox_domain_id,
    ownerBaseUrl: "http://workspace-review.invalid",
  });
  await repo.start();
  const worker = await f.database.selectFrom("workers").selectAll().executeTakeFirstOrThrow();
  const assignment = {
    tenantId: f.tenant.tenantId,
    projectId: f.project.projectId,
    workspaceId: f.project.workspaceId,
    supervisorId: worker.supervisor_id,
    bootId: worker.boot_id,
    sandboxId: worker.id,
    sessionId: f.scope.sessionId,
    runId: f.scope.runId,
    turnId: f.scope.turnId,
    executionReference: f.reference,
  };
  const reservation = {
    activationId: randomUUID(),
    sandboxProfileKey: "starter" as const,
    assignment,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    environmentSha256: "c".repeat(64),
  };
  const age = async (id: string) => {
    await f.database
      .updateTable("workspace_runtimes")
      .set({ updated_at: sql`clock_timestamp() - interval '3 minutes'` })
      .where("workspace_runtime_id", "=", id)
      .execute();
  };
  return {
    ...f,
    repo,
    reservation,
    age,
    async close() {
      try {
        await repo.close();
      } finally {
        await f.close();
      }
    },
  };
}

it("retains shared compute for an active human terminal after Agent work settles", async () => {
  const f = await fixture();
  try {
    const id = f.reservation.activationId;
    expect(await f.repo.reserve(f.reservation)).toEqual({ status: "reserved" });
    await f.repo.setWorkspaceRuntimeState(id, "active");
    await f.age(id);
    expect(await f.repo.claimUnboundWorkspaceRuntimes(16)).toEqual([]);
    await f.database
      .updateTable("runs")
      .set({
        state: "completed",
        settled_at: new Date(),
        stop_reason: "stop",
        execution_released_at: new Date(),
      })
      .where("id", "=", f.scope.runId)
      .execute();
    const terminalId = randomUUID();
    expect(
      await f.repo.reserveTerminal({
        terminalId,
        tenantId: f.tenant.tenantId,
        userId: f.tenant.ownerUserId,
        projectId: f.project.projectId,
        workspaceId: f.project.workspaceId,
        sessionId: f.scope.sessionId,
      }),
    ).toMatchObject({ status: "reserved", workspaceRuntimeId: id });
    await f.repo.setTerminalState(terminalId, "active");
    await f.repo.setWorkspaceRuntimeState(id, "active");
    await f.age(id);
    const candidates = await f.repo.claimUnboundWorkspaceRuntimes(16);
    const terminal = await f.database
      .selectFrom("workspace_terminal_sessions")
      .select("state")
      .where("terminal_id", "=", terminalId)
      .executeTakeFirstOrThrow();
    expect(terminal.state).toBe("active");
    expect(candidates).toEqual([]);
    await f.repo.setTerminalState(terminalId, "released");
    expect(await f.repo.claimUnboundWorkspaceRuntimes(16)).toEqual([
      expect.objectContaining({ activationId: id }),
    ]);
    process.stdout.write(
      JSON.stringify({
        case: "live_terminal_cleanup",
        terminalState: terminal.state,
        selectedForRetirement: candidates.length,
        realPostgres: true,
        vmEffects: 0,
      }) + "\n",
    );
  } finally {
    await f.close();
  }
}, 60_000);

it("retains native ephemeral child compute under its shared root lease", async () => {
  const f = await fixture();
  try {
    const call = await f.command({
      action: "run",
      task: "Owned child fixture",
      sandbox: "ephemeral",
    });
    const jobs = new PostgresSubagentConversations({ database: f.database, native: f.native });
    const child = await jobs.start({
      id: call.operationId,
      tenantId: f.scope.tenantId,
      rootRunId: f.scope.runId,
      parentSessionId: f.scope.sessionId,
      parentTurnId: f.scope.turnId,
      executionReference: f.reference,
      parentToolCallId: `task:${call.taskId}`,
      source: { sequence: call.nativeSequence, taskId: call.taskId },
      prompt: "Owned child fixture",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "ephemeral",
    });
    const reservation = {
      ...f.reservation,
      computeSessionId: child.childSessionId,
      assignment: {
        ...f.reservation.assignment,
        sessionId: child.childSessionId,
        turnId: child.childTurnId,
      },
    };
    expect(await f.repo.reserve(reservation)).toEqual({ status: "reserved" });
    await f.repo.setWorkspaceRuntimeState(reservation.activationId, "active");
    await f.age(reservation.activationId);
    const current = await jobs.status(f.scope.tenantId, child.executionId);
    const authority = await f.database
      .selectFrom("active_execution_scopes")
      .select("lease_id")
      .where("lease_id", "=", f.scope.writerId)
      .where("valid_until", ">", sql<Date>`clock_timestamp()`)
      .where("accepting_effects", "=", true)
      .execute();
    expect(current.state).toBe("running");
    expect(authority).toHaveLength(1);
    expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);
    const candidates = await f.repo.claimUnboundWorkspaceRuntimes(16);
    expect(candidates).toEqual([]);
    await f.settle(child.executionId);
    expect(await f.repo.claimUnboundWorkspaceRuntimes(16)).toEqual([
      expect.objectContaining({ activationId: reservation.activationId }),
    ]);
    process.stdout.write(
      JSON.stringify({
        case: "native_child_cleanup",
        childState: current.state,
        validRootAuthorities: authority.length,
        selectedForRetirement: candidates.length,
        cloudRuns: 1,
        realPostgres: true,
        vmEffects: 0,
      }) + "\n",
    );
  } finally {
    await f.close();
  }
}, 60_000);

it("rechecks a retirement candidate after a terminal is admitted", async () => {
  const candidateRead = Promise.withResolvers<void>();
  const continueCleanup = Promise.withResolvers<void>();
  let held = false;
  const f = await fixture(async (query) => {
    if (held && query.startsWith('select "activation"."workspace_id" from "workspace_runtimes"')) {
      held = false;
      candidateRead.resolve();
      await continueCleanup.promise;
    }
  });
  let cleanup: ReturnType<typeof f.repo.claimUnboundWorkspaceRuntimes> | undefined;
  try {
    const id = f.reservation.activationId;
    await f.repo.reserve(f.reservation);
    await f.repo.setWorkspaceRuntimeState(id, "active");
    await f.age(id);
    await f.database
      .updateTable("runs")
      .set({
        state: "completed",
        settled_at: new Date(),
        stop_reason: "stop",
        execution_released_at: new Date(),
      })
      .where("id", "=", f.scope.runId)
      .execute();
    held = true;
    cleanup = f.repo.claimUnboundWorkspaceRuntimes(16);
    void cleanup.catch(() => {});
    await candidateRead.promise;
    expect(
      await f.repo.reserveTerminal({
        terminalId: randomUUID(),
        tenantId: f.tenant.tenantId,
        userId: f.tenant.ownerUserId,
        projectId: f.project.projectId,
        workspaceId: f.project.workspaceId,
        sessionId: f.scope.sessionId,
      }),
    ).toMatchObject({ status: "reserved", workspaceRuntimeId: id });
    continueCleanup.resolve();
    expect(await cleanup).toEqual([]);
    expect(
      await f.database
        .selectFrom("workspace_runtimes")
        .select("state")
        .where("workspace_runtime_id", "=", id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "active" });
  } finally {
    continueCleanup.resolve();
    await cleanup?.catch(() => {});
    await f.close();
  }
}, 60_000);

it("arbitrates warm retirement and terminal admission under the Workspace lock", async () => {
  const f = await fixture();
  try {
    const id = f.reservation.activationId;
    await f.repo.reserve(f.reservation);
    await f.repo.setWorkspaceRuntimeState(id, "warm");
    const terminalId = randomUUID();
    const input = {
      terminalId,
      tenantId: f.tenant.tenantId,
      userId: f.tenant.ownerUserId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: f.scope.sessionId,
    };
    expect(await f.repo.reserveTerminal(input)).toMatchObject({ status: "reserved" });
    // A reserved terminal is already a holder, even before its PTY is ready.
    expect(await f.repo.claimWarmRuntimeRetirement(id)).toBe(false);
    await f.repo.setTerminalState(terminalId, "released");
    expect(await f.repo.claimWarmRuntimeRetirement(id)).toBe(true);
    // The opposite ordering must not silently create a second VM for the terminal.
    expect(await f.repo.reserveTerminal({ ...input, terminalId: randomUUID() })).toEqual({
      status: "busy",
    });
  } finally {
    await f.close();
  }
}, 60_000);

async function controllerFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await f.database
    .selectFrom("environment_versions")
    .selectAll()
    .where("project_id", "=", f.project.projectId)
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
  const environment = parseEnvironmentRuntimeSnapshot({
    environmentVersionId: row.id,
    versionNumber: Number(row.version_number),
    profileKey: row.profile_key,
    profileVersion: row.profile_version,
    imageRevision: row.image_revision,
    specSha256: row.spec_sha256,
    recipe: row.recipe,
    recipeSha256: row.recipe_sha256,
  });
  const environmentValidation = parseEnvironmentValidationReport({
    profileKey: environment.profileKey,
    profileVersion: environment.profileVersion,
    imageRevision: environment.imageRevision,
    specSha256: environment.specSha256,
    recipeSha256: environment.recipeSha256,
    isolationBoundary: "microvm",
    runtime: "cubesandbox-kvm",
    networkMode: "public_web_proxy_private_denied",
    runAsUser: "1000:1000",
    readOnlyRootFilesystem: false,
    tools: [
      { name: "node", version: "v24.0.0" },
      { name: "java", version: "17" },
      { name: "python", version: "3.11" },
      { name: "git", version: "2.39" },
    ],
    recipeCommands: [],
  });
  const closed: string[] = [];
  const adopted: string[] = [];
  const physical = new Map<string, SandboxHandle>();
  let now = Date.now();
  const provider = {
    providerId: "cubesandbox",
    defaultPolicy: CUBESANDBOX_TOOL_POLICY,
    async checkHealth() {},
    async observeRuntimeInventory() {
      return new Map();
    },
    async inspect() {
      throw new Error("Physical inspection is outside this controlled fixture");
    },
    async close() {},
    async create(spec, authorization) {
      const handle: SandboxHandle = {
        allocation: authorization,
        providerApiVersion: 1,
        providerId: "cubesandbox",
        activationId: spec.activationId,
        runtimeId: randomUUID(),
        runtimeName: "owned-review-vm",
        runtimeNodeId: "review-node",
        workspaceRoot: spec.toolRoot ?? "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      };
      physical.set(spec.activationId, handle);
      return handle;
    },
    async destroy(handle) {
      closed.push(handle.activationId);
      physical.delete(handle.activationId);
    },
    async destroyRuntime(id) {
      closed.push(id);
      physical.delete(id);
    },
    async destroyPersistentCapsule(_capsule, id) {
      closed.push(id);
      physical.delete(id);
    },
    async persistentCapsule(handle) {
      return { handle, capsule: `review:${handle.activationId}` };
    },
    async adoptPersistentCapsule(capsule) {
      const id = capsule.slice("review:".length),
        handle = physical.get(id);
      if (!handle) throw new Error("Fixture physical runtime is absent");
      adopted.push(id);
      return handle;
    },
    async detachPersistent() {},
    executionIdentity(handle) {
      return handle.activationId;
    },
    async observeRuntime(handle) {
      return {
        runtimeName: handle.runtimeName,
        nodeId: "review-node",
        presence: "present",
        state: "running",
      };
    },
    async probeExecution(handle) {
      return { continuityId: handle.activationId };
    },
    async describeExecution(handle, activationId, toolRoot) {
      return {
        version: 2,
        target: {
          apiUrl: "http://review.invalid",
          sandboxId: handle.runtimeName,
          nodeId: "review-node",
          bootId: "11111111-1111-4111-8111-111111111111",
        },
        attachment: { activationId, toolRoot },
      };
    },
    async openTerminal() {
      return {
        pid: 1,
        output: { async *[Symbol.asyncIterator]() {} },
        async sendInput() {},
        async resize() {},
        async kill() {},
        disconnect() {},
      };
    },
  } satisfies SandboxProvider;
  const bindings = new InMemorySandboxBindings();
  const controller = new SandboxController({
    provider,
    stateRepository: f.repo,
    bindings,
    ownerBaseUrl: "http://workspace-review.invalid",
    imageRevision: row.image_revision,
    clock: () => now,
    warmTtlMs: 1000,
  });
  const request: ToolSandboxCreateRequest = {
    toolBrokerProtocolVersion: 1 as const,
    type: "tool_sandbox.create" as const,
    requestId: randomUUID(),
    sandboxProfileKey: "starter" as const,
    toolRoot: "/workspace",
    assignment: f.reservation.assignment,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    allowedTools: ["bash"],
    executionMode: "elastic" as const,
    environment,
    workspaceSeed: { kind: "sample_java" },
  };
  return {
    controller,
    bindings,
    environment,
    request,
    closed,
    adopted,
    physical,
    advanceWarmClock() {
      now += 1001;
    },
  };
}

it("keeps terminal-owned compute alive through actual Controller/PG cleanup", async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof controllerFixture>> | undefined;
  let terminal: Awaited<ReturnType<SandboxController["openTerminal"]>> | undefined;
  try {
    c = await controllerFixture(f);
    const binding = await c.controller.create(c.request);
    terminal = await c.controller.openTerminal({
      tenantId: f.tenant.tenantId,
      userId: f.tenant.ownerUserId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: f.scope.sessionId,
      environment: c.environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 80 },
    });
    await c.bindings.closeBinding(binding.activationId, f.reservation.assignment);
    await c.controller.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: randomUUID(),
      activationId: binding.activationId,
      assignment: f.reservation.assignment,
      disposition: "keep_warm",
    });
    await f.database
      .updateTable("runs")
      .set({
        state: "completed",
        settled_at: new Date(),
        stop_reason: "stop",
        execution_released_at: new Date(),
      })
      .where("id", "=", f.scope.runId)
      .execute();
    const id = [...c.physical.keys()][0]!;
    await f.age(id);
    await c.controller.reapWorkspaceRuntimes();
    expect(c.closed).toEqual([]);
    const t = await f.database
      .selectFrom("workspace_terminal_sessions")
      .select("state")
      .where("terminal_id", "=", terminal.terminalId)
      .executeTakeFirstOrThrow();
    expect(t.state).toBe("active");
    process.stdout.write(
      JSON.stringify({
        case: "controller_terminal_retirement",
        terminalState: t.state,
        providerDestroyCalls: c.closed.length,
        realPostgres: true,
        realVM: false,
      }) + "\n",
    );
  } finally {
    await terminal?.close().catch(() => undefined);
    await c?.controller.close().catch(() => undefined);
    await f.close();
  }
}, 60_000);

it("does not adopt terminal-owned compute again or place it in the warm pool", async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof controllerFixture>> | undefined;
  let terminal: Awaited<ReturnType<SandboxController["openTerminal"]>> | undefined;
  try {
    c = await controllerFixture(f);
    const binding = await c.controller.create(c.request);
    terminal = await c.controller.openTerminal({
      tenantId: f.tenant.tenantId,
      userId: f.tenant.ownerUserId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: f.scope.sessionId,
      environment: c.environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 80 },
    });
    await c.bindings.closeBinding(binding.activationId, f.reservation.assignment);
    await c.controller.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: randomUUID(),
      activationId: binding.activationId,
      assignment: f.reservation.assignment,
      disposition: "keep_warm",
    });
    expect(c.controller.warmCount).toBe(0);
    expect(await c.controller.recoverPersistentDevelopmentEnvironments()).toBe(0);
    expect(await c.controller.recoverPersistentDevelopmentEnvironments()).toBe(0);
    expect(c.adopted).toEqual([]);
    expect(c.controller.warmCount).toBe(0);
    c.advanceWarmClock();
    await c.controller.reapWarm();
    expect(c.closed).toEqual([]);
    const t = await f.database
      .selectFrom("workspace_terminal_sessions")
      .select("state")
      .where("terminal_id", "=", terminal.terminalId)
      .executeTakeFirstOrThrow();
    expect(t.state).toBe("active");
    await terminal.close();
    expect(c.controller.warmCount).toBe(1);
    c.advanceWarmClock();
    await c.controller.reapWarm();
    expect(c.closed).toHaveLength(1);
    process.stdout.write(
      JSON.stringify({
        case: "terminal_duplicate_adoption",
        terminalStateBeforeClose: t.state,
        duplicateAdoptions: c.adopted.length,
        destroyCallsAfterLastTerminalClosed: c.closed.length,
        realPostgres: true,
        realVM: false,
        shortenedWarmTtlMs: 1000,
      }) + "\n",
    );
  } finally {
    await terminal?.close().catch(() => undefined);
    await c?.controller.close().catch(() => undefined);
    await f.close();
  }
}, 60_000);

it("keeps live native child compute alive through actual Controller/PG cleanup", async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof controllerFixture>> | undefined;
  try {
    const call = await f.command({
      action: "run",
      task: "Owned child fixture",
      sandbox: "ephemeral",
    });
    const jobs = new PostgresSubagentConversations({ database: f.database, native: f.native });
    const child = await jobs.start({
      id: call.operationId,
      tenantId: f.scope.tenantId,
      rootRunId: f.scope.runId,
      parentSessionId: f.scope.sessionId,
      parentTurnId: f.scope.turnId,
      executionReference: f.reference,
      parentToolCallId: `task:${call.taskId}`,
      source: { sequence: call.nativeSequence, taskId: call.taskId },
      prompt: "Owned child fixture",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "ephemeral",
    });
    c = await controllerFixture(f);
    await c.controller.create({
      ...c.request,
      computeSessionId: child.childSessionId,
      assignment: {
        ...c.request.assignment,
        sessionId: child.childSessionId,
        turnId: child.childTurnId,
      },
    });
    const id = [...c.physical.keys()][0]!;
    await f.age(id);
    await c.controller.reapWorkspaceRuntimes();
    expect(c.closed).toEqual([]);
    expect((await jobs.status(f.scope.tenantId, child.executionId)).state).toBe("running");
    expect(
      await f.database
        .selectFrom("active_execution_scopes")
        .select("lease_id")
        .where("lease_id", "=", f.scope.writerId)
        .where("accepting_effects", "=", true)
        .where("valid_until", ">", sql<Date>`clock_timestamp()`)
        .execute(),
    ).toHaveLength(1);
    process.stdout.write(
      JSON.stringify({
        case: "controller_child_retirement",
        childState: "running",
        validRootAuthorities: 1,
        providerDestroyCalls: c.closed.length,
        realPostgres: true,
        realVM: false,
      }) + "\n",
    );
  } finally {
    await c?.controller.close().catch(() => undefined);
    await f.close();
  }
}, 60_000);

it("serializes Run and terminal admission in Session/Workspace order", async () => {
  const f = await fixture();
  let repo: PostgresWorkspaceRuntimeStateRepository | undefined;
  let releaseSession!: () => void, releaseWorkspace!: () => void;
  let markSession!: () => void, markWorkspace!: () => void;
  const sessionHeld = new Promise<void>((r) => {
    markSession = r;
  });
  const workspaceHeld = new Promise<void>((r) => {
    markWorkspace = r;
  });
  const sessionGate = new Promise<void>((r) => {
    releaseSession = r;
  });
  const workspaceGate = new Promise<void>((r) => {
    releaseWorkspace = r;
  });
  const statements = new WeakMap<object, string>();
  const firstTerminalLock = Promise.withResolvers<"session" | "workspace">();
  let enabled = false;
  let admission: Promise<unknown> | undefined, terminal: Promise<unknown> | undefined;
  try {
    const session = await f.store.createSession(
      f.project.projectId,
      f.project.workspaceId,
      "Lock order",
      "elastic",
    );
    const measured = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        const query = f.database.getExecutor().compileQuery(node, queryId).sql;
        statements.set(queryId, query);
        if (enabled && query.includes("for update")) {
          if (query.includes('from "sessions" as "s"')) firstTerminalLock.resolve("session");
          if (
            query.startsWith(
              'select "sandbox_domain_id", "project_id", "workspace_kind" from "workspaces"',
            )
          )
            firstTerminalLock.resolve("workspace");
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        const q = statements.get(queryId) ?? "";
        if (
          enabled &&
          q.includes('from "sessions" as "session_row"') &&
          q.includes("for no key update")
        ) {
          markSession();
          await sessionGate;
        }
        if (
          enabled &&
          q.startsWith(
            'select "sandbox_domain_id", "project_id", "workspace_kind" from "workspaces"',
          ) &&
          q.includes("for update")
        ) {
          markWorkspace();
          await workspaceGate;
        }
        return result;
      },
    });
    const domain = await f.database
      .selectFrom("workspaces")
      .select("sandbox_domain_id")
      .where("id", "=", f.project.workspaceId)
      .executeTakeFirstOrThrow();
    repo = new PostgresWorkspaceRuntimeStateRepository({
      database: measured,
      instanceId: randomUUID(),
      sandboxDomainId: domain.sandbox_domain_id,
      ownerBaseUrl: "http://workspace-lock-review.invalid",
    });
    await repo.start();
    const store = new ControlPlaneStore({ database: measured, ...f.tenant });
    enabled = true;
    admission = store.acceptTurn(session.sessionId, "review-lock-order", {
      prompt: "Owned fixture",
    });
    void admission.catch(() => undefined);
    await Promise.race([
      sessionHeld,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Session lock not reached")), 5000),
      ),
    ]);
    terminal = repo.reserveTerminal({
      terminalId: randomUUID(),
      tenantId: f.tenant.tenantId,
      userId: f.tenant.ownerUserId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: session.sessionId,
    });
    void terminal.catch(() => undefined);
    expect(await firstTerminalLock.promise).toBe("session");
    releaseSession();
    await Promise.race([
      workspaceHeld,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Workspace lock not reached")), 5000),
      ),
    ]);
    const started = performance.now();
    releaseSession();
    releaseWorkspace();
    const results = await Promise.allSettled([admission, terminal]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");
    process.stdout.write(
      JSON.stringify({
        case: "terminal_admission_lock_inversion",
        agent: results[0].status,
        terminal: results[1].status,
        elapsedMs: Math.round(performance.now() - started),
        realPostgres: true,
      }) + "\n",
    );
  } finally {
    enabled = false;
    releaseSession();
    releaseWorkspace();
    await Promise.allSettled([admission, terminal]);
    await repo?.close();
    await f.close();
  }
}, 60_000);

it("measures the current empty Workspace deletion SQL without removing its admission checks", async () => {
  const f = await fixture();
  try {
    const project = await f.store.createProject({
      name: "Delete query count",
      source: { kind: "empty" },
    });
    const statements = new WeakMap<object, string>();
    const queries: string[] = [];
    const measured = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        statements.set(queryId, f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ queryId, result }) {
        queries.push(statements.get(queryId)!);
        return result;
      },
    });
    const store = new ControlPlaneStore({ database: measured, ...f.tenant });
    const result = await store.deleteWorkspace(project.workspaceId, "review-delete-sql");
    expect(result.storageState).toBe("pending");
    expect(queries).toHaveLength(8);
    process.stdout.write(
      JSON.stringify({
        case: "workspace_delete_sql",
        businessStatements: queries.length,
        statements: queries.map((q) => q.split(" where ")[0]),
        realPostgres: true,
        excludesBeginCommit: true,
      }) + "\n",
    );
  } finally {
    await f.close();
  }
}, 60_000);
