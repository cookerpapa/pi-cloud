import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { createExecutionReference } from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  type EnvironmentValidationReport,
} from "@pi-cloud/protocol";
import {
  PostgresWorkspaceRuntimeStateRepository,
  CUBESANDBOX_TOOL_POLICY,
  ToolBroker,
  ToolBrokerServer,
  type SandboxHandle,
  type SandboxProvider,
} from "@pi-cloud/tool-broker";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import * as undici from "undici";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { DevelopmentEnvironmentService } from "../src/development-environment-service.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { SshAccessTicketService } from "../src/ssh-access-ticket-service.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";

vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();
  return { ...original, fetch: vi.fn(original.fetch) };
});

const DOMAIN_ID = "sandbox-domain-development";
const TOKEN = `development-environment-${"t".repeat(48)}`;
const IMAGE_REVISION = "development-environment-test";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let server: ToolBrokerServer;
let service: DevelopmentEnvironmentService;
let stateRepository: PostgresWorkspaceRuntimeStateRepository;
let store: ControlPlaneStore;
let identity: TenantRequestIdentity;
let otherIdentity: TenantRequestIdentity;
let workspaceId: string;
let sessionId: string;
const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
let admin: Pool | undefined;
let testDatabase: string | undefined;
const pauses = vi.fn(async () => undefined);
const resumes = vi.fn(async (handle: SandboxHandle) => handle);
const destroys = vi.fn(async (_handle: SandboxHandle) => undefined);

function provider(): SandboxProvider {
  const validation: EnvironmentValidationReport = {
    profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
    profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
    imageRevision: IMAGE_REVISION,
    specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
    recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    isolationBoundary: "microvm",
    runtime: "cubesandbox-kvm",
    networkMode: "public_web_proxy_private_denied",
    runAsUser: "1000:1000",
    readOnlyRootFilesystem: false,
    tools: [
      { name: "git", version: "2" },
      { name: "node", version: "24" },
      { name: "java", version: "17" },
      { name: "python", version: "3.11" },
    ],
    recipeCommands: [],
  };
  return {
    providerId: "cubesandbox",
    defaultPolicy: CUBESANDBOX_TOOL_POLICY,
    async checkHealth() {},
    async create(spec) {
      return {
        providerApiVersion: 1,
        providerId: "cubesandbox",
        activationId: spec.activationId,
        runtimeId: spec.activationId,
        runtimeName: `development-${spec.activationId}`,
        ipAddress: "169.254.68.4",
        workspaceRoot: spec.toolRoot ?? "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation: validation,
      };
    },
    async exec() {
      throw new Error("not used");
    },
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
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
    async listDirectory(_handle, path) {
      return {
        path,
        entries: [
          {
            name: "empty-project",
            path: `${path === "/" ? "" : path}/empty-project`,
            kind: "directory",
          },
          {
            name: "README",
            path: `${path === "/" ? "" : path}/README`,
            kind: "file",
            sizeBytes: 12,
          },
        ],
      };
    },
    async createDirectory(_handle, path, name) {
      return {
        path,
        entries: [{ name, path: `${path === "/" ? "" : path}/${name}`, kind: "directory" }],
      };
    },
    pause: pauses,
    resume: resumes,
    async persistentCapsule(handle) {
      return { handle, capsule: "c".repeat(64) };
    },
    async adoptPersistentCapsule() {
      throw new Error("test provider has no detached development environment");
    },
    async detachPersistent() {},
    async stop(handle) {
      await destroys(handle);
    },
    destroy: destroys,
    async inspect(handle) {
      return { providerApiVersion: 1, providerId: "cubesandbox", state: "absent", handle };
    },
    async destroyRuntime() {},
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async close() {},
  };
}

beforeAll(async () => {
  if (external) {
    admin = new Pool({ connectionString: external, max: 1 });
    testDatabase = `pi_machines_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${testDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${testDatabase}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
  } else {
    pglite = await PGlite.create();
    socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
  }
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "development-environment",
    ownerDisplayName: "Environment Owner",
    quotas: {
      maximumProjects: 4,
      maximumSessions: 16,
    },
  });
  const otherUserId = "88888888-8888-4888-8888-888888888888";
  await database
    .insertInto("users")
    .values({ id: otherUserId, tenant_id: tenant.tenantId, display_name: "Other User" })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sandbox_domains")
    .values({
      id: DOMAIN_ID,
      display_name: "Development",
      state: "active",
      tool_broker_base_url: "http://127.0.0.1:1",
      workspace_storage_key: "development-volume",
      maximum_active_sandboxes: 8,
    })
    .executeTakeFirstOrThrow();
  await database
    .updateTable("sandbox_domains")
    .set({ state: "disabled" })
    .where("id", "=", "sandbox-domain-0001")
    .execute();
  store = new ControlPlaneStore({
    database,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
    environmentImageRevision: IMAGE_REVISION,
  });
  identity = {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Environment Owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
  otherIdentity = { ...identity, userId: otherUserId, displayName: "Other User", role: "member" };
  const ownerBaseUrl = "http://127.0.0.1:4300";
  stateRepository = new PostgresWorkspaceRuntimeStateRepository({
    database,
    sandboxDomainId: DOMAIN_ID,
    instanceId: "99999999-9999-4999-8999-999999999999",
    ownerBaseUrl,
  });
  await stateRepository.start();
  server = new ToolBrokerServer({
    commands: {
      checkHealth() {},
      async waitResult() {
        throw new Error("Not a Tool command fixture");
      },
    },
    host: "127.0.0.1",
    port: 0,
    serviceToken: `service-${"s".repeat(48)}`,
    terminalToken: TOKEN,
    broker: new ToolBroker({
      provider: provider(),
      stateRepository,
      ownerBaseUrl,
      maximumActiveSandboxes: 4,
      imageRevision: IMAGE_REVISION,
    }),
  });
  const address = await server.listen();
  await database
    .updateTable("sandbox_domains")
    .set({ tool_broker_base_url: address })
    .where("id", "=", DOMAIN_ID)
    .executeTakeFirstOrThrow();
  service = new DevelopmentEnvironmentService({
    database,
    terminalToken: TOKEN,
    allowInsecureInternalHttp: true,
    environmentImageRevision: IMAGE_REVISION,
  });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
  if (admin) {
    if (testDatabase) await admin.query(`drop database "${testDatabase}"`);
    await admin.end();
  }
});

describe("user-owned development environments", () => {
  it.skipIf(!external)(
    "commits one machine when two identical create requests overlap",
    async () => {
      // Hold the tenant lock so both requests can begin admission before either
      // commits. The production transaction, not a process-local lock, must dedup.
      let locked!: () => void, release!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("tenant_runtime_policies")
          .select("tenant_id")
          .where("tenant_id", "=", identity.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked();
        await unblock;
      });
      await lockHeld;
      const requests = [0, 1].map(() =>
        service.create(identity, "duplicate-machine-create", {
          name: "Concurrent machine",
          profileKey: "starter",
        }),
      );
      const outcomes = Promise.allSettled(requests);
      try {
        await vi.waitFor(async () => {
          const waiting = await sql<{
            count: number;
          }>`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`.execute(database);
          expect(waiting.rows[0]?.count).toBe(2);
        });
        release();
        await blocker;
        const results = await outcomes;
        expect(results).toEqual([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({ status: "fulfilled" }),
        ]);
        const machines = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        expect(new Set(machines.map((machine) => machine.environmentId)).size).toBe(1);
        expect(machines.every((machine) => machine.state === "running")).toBe(true);
      } finally {
        release();
        await blocker;
        await outcomes;
        const machine = await database
          .selectFrom("development_environments")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("idempotency_key", "=", "duplicate-machine-create")
          .executeTakeFirst();
        if (machine)
          await service.action(identity, machine.id, "cleanup-duplicate-machine", {
            action: "release",
          });
        destroys.mockClear();
      }
    },
  );

  it("provisions, isolates visibility, pauses, resumes and releases one Workspace KVM", async () => {
    const created = await service.create(identity, "create-exclusive", {
      name: "Backend machine",
      profileKey: "standard",
    });
    workspaceId = created.workspaceId;
    sessionId = (
      await store.createSession(
        created.projectId,
        created.workspaceId,
        "exclusive conversation",
        "development_environment",
        { ownerUserId: identity.userId, workingDirectory: "/home/user" },
      )
    ).sessionId;
    expect(created).toMatchObject({ generation: 1 });
    let running = created;
    for (let attempt = 0; attempt < 100 && running.state !== "running"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      running = await service.get(identity, created.environmentId);
    }
    expect(running.state).toBe("running");
    expect(running.ipAddress).toBe("169.254.68.4");
    await expect(store.listWorkspaces()).resolves.toEqual({ workspaces: [], truncated: false });
    await database
      .updateTable("sandbox_domains")
      .set({ maximum_active_sandboxes: 1 })
      .where("id", "=", DOMAIN_ID)
      .executeTakeFirstOrThrow();
    await expect(
      service.create(identity, "capacity-rejected-machine", {
        name: "No capacity machine",
        profileKey: "starter",
      }),
    ).rejects.toMatchObject({ code: "capacity_exhausted" });
    await expect(
      database
        .selectFrom("development_environments as environment")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "environment.tenant_id")
            .onRef("workspace.id", "=", "environment.workspace_id"),
        )
        .select([
          "environment.state",
          "environment.failure_code as failureCode",
          "workspace.workspace_kind as workspaceKind",
          "workspace.deleted_at as deletedAt",
        ])
        .where("environment.tenant_id", "=", identity.tenantId)
        .where("environment.idempotency_key", "=", "capacity-rejected-machine")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "released",
      failureCode: "capacity_exhausted",
      workspaceKind: "development_environment",
      deletedAt: expect.any(Date),
    });
    await database
      .updateTable("sandbox_domains")
      .set({ maximum_active_sandboxes: 8 })
      .where("id", "=", DOMAIN_ID)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("tenant_runtime_policies")
      .set({ maximum_projects: 1 })
      .where("tenant_id", "=", identity.tenantId)
      .executeTakeFirstOrThrow();
    await expect(
      service.create(identity, "project-quota-rejected-machine", {
        name: "No project quota machine",
        profileKey: "starter",
      }),
    ).rejects.toMatchObject({ code: "tenant_quota_exceeded" });
    await expect(
      database
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", identity.tenantId)
        .where("idempotency_key", "=", "project-quota-rejected-machine")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
    await database
      .updateTable("tenant_runtime_policies")
      .set({ maximum_projects: 4 })
      .where("tenant_id", "=", identity.tenantId)
      .executeTakeFirstOrThrow();
    await expect(
      service.directory(identity, created.environmentId, "/home"),
    ).resolves.toMatchObject({
      path: "/home",
      entries: [{ name: "empty-project", kind: "directory" }, { kind: "file" }],
    });
    await expect(
      service.createDirectory(identity, created.environmentId, {
        path: "/home",
        name: "new-project",
      }),
    ).resolves.toMatchObject({
      path: "/home",
      entries: [{ name: "new-project", kind: "directory" }],
    });
    await expect(service.directory(otherIdentity, created.environmentId, "/home")).rejects.toThrow(
      /not found/u,
    );
    const sshTickets = new SshAccessTicketService({
      database,
      enabled: true,
      advertisedHost: "127.0.0.1",
      advertisedPort: 2_222,
      clock: () => new Date("2026-08-23T00:00:00.000Z"),
      idGenerator: () => "12121212-1212-4212-8212-121212121212",
      secretGenerator: () => "s".repeat(43),
    });
    const ticket = await sshTickets.issue(identity, sessionId);
    expect(ticket).toMatchObject({
      sessionId,
      environmentId: created.environmentId,
      command: "ssh -p 2222 picloud@127.0.0.1",
      username: "picloud",
      expiresAt: "2026-08-24T00:00:00.000Z",
    });
    expect(ticket.oneLineCommand).toContain("sshpass -e ssh");
    expect(ticket.password).toMatch(/^pcssh_/);
    expect(
      JSON.stringify(
        await database
          .selectFrom("ssh_access_tickets")
          .select("secret_sha256")
          .where("ticket_id", "=", ticket.ticketId)
          .executeTakeFirstOrThrow(),
      ),
    ).not.toContain(ticket.password);
    await expect(
      stateRepository.reserve({
        activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assignment: {
          tenantId: identity.tenantId,
          projectId: created.projectId,
          workspaceId,
          supervisorId: "worker",
          bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sandboxId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          runId: "run",
          sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          executionReference: createExecutionReference(
            "11111111-1111-4111-8111-111111111111",
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            1,
          ),
        },
        turnContextSha256: "b".repeat(64),
        attemptContextSha256: "c".repeat(64),
        environmentSha256: "d".repeat(64),
      }),
    ).resolves.toEqual({ status: "busy" });
    await expect(service.list(otherIdentity)).resolves.toEqual({
      environments: [],
      profiles: expect.any(Array),
      truncated: false,
    });
    await expect(service.get(otherIdentity, created.environmentId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.create(identity, "create-exclusive", {
        name: "Different machine",
        profileKey: "performance",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await expect(
      service.action(identity, created.environmentId, "pause-exclusive", { action: "pause" }),
    ).resolves.toMatchObject({ state: "paused" });
    expect(pauses).toHaveBeenCalledOnce();
    await expect(
      service.action(identity, created.environmentId, "resume-exclusive", { action: "resume" }),
    ).resolves.toMatchObject({ state: "running" });
    expect(resumes).toHaveBeenCalledOnce();
    await database
      .updateTable("development_environments")
      .set({ agent_activation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
      .where("id", "=", created.environmentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.action(identity, created.environmentId, "release-exclusive-busy", {
        action: "release",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(destroys).not.toHaveBeenCalled();
    await database
      .updateTable("development_environments")
      .set({ agent_activation_id: null })
      .where("id", "=", created.environmentId)
      .executeTakeFirstOrThrow();
    await expect(
      service.action(identity, created.environmentId, "release-exclusive", { action: "release" }),
    ).resolves.toMatchObject({ state: "released", releasedAt: expect.any(String) });
    expect(destroys).toHaveBeenCalledOnce();
    await expect(
      database
        .selectFrom("workspaces")
        .select(["deleted_at as deletedAt", "storage_purged_at as storagePurgedAt"])
        .where("id", "=", workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: expect.any(Date), storagePurgedAt: null });
    await expect(store.listWorkspaces()).resolves.toEqual({ workspaces: [], truncated: false });
    await expect(store.getConversation(sessionId)).resolves.toMatchObject({
      session: { workspaceId, workspaceState: "missing" },
    });
    await expect(
      database
        .selectFrom("workspace_delete_operations")
        .select(["detached_session_count as detachedSessionCount"])
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", workspaceId)
        .execute(),
    ).resolves.toEqual([{ detachedSessionCount: 1 }]);
    await expect(
      service.action(identity, created.environmentId, "release-exclusive-retry", {
        action: "release",
      }),
    ).resolves.toMatchObject({ state: "released", releasedAt: expect.any(String) });
    expect(destroys).toHaveBeenCalledOnce();
    await expect(service.list(identity)).resolves.toMatchObject({ environments: [] });
    await expect(
      database
        .selectFrom("workspace_delete_operations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("does not destroy a machine used by a queued message before lazy Tool activation", async () => {
    const machine = await service.create(identity, "queued-machine", {
      name: "Queued message machine",
      profileKey: "starter",
    });
    const session = await store.createSession(
      machine.projectId,
      machine.workspaceId,
      "queued message",
      "development_environment",
      { ownerUserId: identity.userId, workingDirectory: "/home/user" },
    );
    const accepted = await store.acceptTurn(session.sessionId, "queued-message", {
      prompt: "continue",
    });
    const destroyedBefore = destroys.mock.calls.length;
    try {
      await expect(
        service.action(identity, machine.environmentId, "release-queued", {
          action: "release",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(destroys.mock.calls.length).toBe(destroyedBefore);
      await expect(service.get(identity, machine.environmentId)).resolves.toMatchObject({
        state: "running",
      });
    } finally {
      await database
        .updateTable("runs")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("id", "=", accepted.runId)
        .execute();
      await database
        .updateTable("turns")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("id", "=", accepted.turnId)
        .execute();
      await service.action(identity, machine.environmentId, "cleanup-queued", {
        action: "release",
      });
    }
  });

  it.each(["drained-domain", "failed-profile"])(
    "releases the physical machine despite %s, without depending on new-allocation policy",
    async (failure) => {
      const machine = await service.create(identity, `release-${failure}`, {
        name: failure,
        profileKey: "starter",
      });
      const destroyedBefore = destroys.mock.calls.length;
      try {
        if (failure === "drained-domain") {
          await database
            .updateTable("sandbox_domains")
            .set({ state: "disabled" })
            .where("id", "=", DOMAIN_ID)
            .execute();
        } else {
          await database
            .updateTable("environment_versions")
            .set({ state: "failed", failure_code: "test-profile-failure", validated_at: null })
            .where("project_id", "=", machine.projectId)
            .execute();
        }
        await expect(
          service.directory(identity, machine.environmentId, "/home"),
        ).resolves.toMatchObject({ path: "/home" });
        await expect(
          service.createDirectory(identity, machine.environmentId, {
            path: "/home",
            name: "still-usable",
          }),
        ).resolves.toMatchObject({ entries: [{ name: "still-usable", kind: "directory" }] });
        expect(
          await service.action(identity, machine.environmentId, `release-${failure}`, {
            action: "release",
          }),
        ).toMatchObject({ state: "released" });
        expect(destroys.mock.calls.length).toBe(destroyedBefore + 1);
      } finally {
        await database
          .updateTable("sandbox_domains")
          .set({ state: "active" })
          .where("id", "=", DOMAIN_ID)
          .execute();
        await database
          .updateTable("environment_versions")
          .set({ state: "validated", failure_code: null, validated_at: new Date() })
          .where("project_id", "=", machine.projectId)
          .execute();
        await service.action(identity, machine.environmentId, `cleanup-${failure}`, {
          action: "release",
        });
      }
    },
  );

  it.each(["request", "response", "restart"] as const)(
    "recovers a release after lost %s without admitting new work",
    async (failure) => {
      const machine = await service.create(identity, `retry-release-machine-${failure}`, {
        name: `Retry release machine ${failure}`,
        profileKey: "starter",
      });
      const session = await store.createSession(
        machine.projectId,
        machine.workspaceId,
        "release boundary",
        "development_environment",
        { ownerUserId: identity.userId, workingDirectory: "/home/user" },
      );
      const originalFetch = (await vi.importActual<typeof import("undici")>("undici")).fetch;
      const destroyedBefore = destroys.mock.calls.length;
      const fetchRequest = vi.mocked(undici.fetch).mockImplementationOnce(async (...args) => {
        if (failure === "response") await (await originalFetch(...args)).arrayBuffer();
        throw new Error("injected connection loss");
      });
      try {
        await expect(
          service.action(identity, machine.environmentId, "lost-release", {
            action: "release",
          }),
        ).rejects.toThrow("injected connection loss");
      } finally {
        fetchRequest.mockReset().mockImplementation(originalFetch);
      }
      try {
        await expect(
          store.acceptTurn(session.sessionId, "after-release-intent", { prompt: "must not start" }),
        ).rejects.toMatchObject({ code: "conflict" });
        if (failure === "restart") {
          const replacement = new DevelopmentEnvironmentService({
            database,
            terminalToken: TOKEN,
            allowInsecureInternalHttp: true,
            environmentImageRevision: IMAGE_REVISION,
          });
          try {
            await expect(
              replacement.reconcileLifecycle(new Date(Date.now() + 1_000)),
            ).resolves.toBe(1);
          } finally {
            await replacement.close();
          }
        } else {
          await expect(
            service.action(identity, machine.environmentId, "lost-release", { action: "release" }),
          ).resolves.toMatchObject({ state: "released" });
        }
        expect(destroys.mock.calls.length).toBe(destroyedBefore + 1);
        await expect(service.get(identity, machine.environmentId)).resolves.toMatchObject({
          state: "released",
        });
      } finally {
        await database
          .updateTable("runs")
          .set({ state: "cancelled", settled_at: new Date() })
          .where("session_id", "=", session.sessionId)
          .execute();
        await database
          .updateTable("turns")
          .set({ state: "cancelled", settled_at: new Date() })
          .where("session_id", "=", session.sessionId)
          .execute();
        await service.action(identity, machine.environmentId, "cleanup-release-boundary", {
          action: "release",
        });
      }
    },
  );

  it.each(["request", "response"] as const)(
    "does not report an unconfirmed pause as completed after lost %s",
    async (failure) => {
      const machine = await service.create(identity, `pause-gap-${failure}`, {
        name: `Pause gap ${failure}`,
        profileKey: "starter",
      });
      const originalFetch = (await vi.importActual<typeof import("undici")>("undici")).fetch;
      const before = pauses.mock.calls.length;
      vi.mocked(undici.fetch).mockImplementationOnce(async (...args) => {
        if (failure === "response") await (await originalFetch(...args)).arrayBuffer();
        throw new Error("lost pause transport");
      });
      try {
        await expect(
          service.action(identity, machine.environmentId, "uncertain-pause", { action: "pause" }),
        ).rejects.toThrow("lost pause transport");
        vi.mocked(undici.fetch).mockImplementation(originalFetch);
        await expect(
          service.action(identity, machine.environmentId, "uncertain-pause", { action: "pause" }),
        ).rejects.toMatchObject({
          code: "conflict",
          message: expect.stringContaining("not confirmed"),
        });
        expect(pauses.mock.calls.length - before).toBe(failure === "response" ? 1 : 0);
      } finally {
        vi.mocked(undici.fetch).mockImplementation(originalFetch);
        await service.action(identity, machine.environmentId, "cleanup-pause-gap", {
          action: "release",
        });
      }
    },
  );

  it("records the acknowledged action result, not a later opposite action's state", async () => {
    const machine = await service.create(identity, "opposite-state", {
      name: "Opposite state",
      profileKey: "starter",
    });
    const originalFetch = (await vi.importActual<typeof import("undici")>("undici")).fetch;
    const before = pauses.mock.calls.length;
    vi.mocked(undici.fetch).mockImplementationOnce(async (...args) => {
      const response = await originalFetch(...args);
      await service.action(identity, machine.environmentId, "later-resume", { action: "resume" });
      return response;
    });
    try {
      await expect(
        service.action(identity, machine.environmentId, "earlier-pause", { action: "pause" }),
      ).resolves.toMatchObject({ state: "running" });
      const receipt = await database
        .selectFrom("development_environment_operations")
        .select("result_state")
        .where("environment_id", "=", machine.environmentId)
        .where("idempotency_key", "=", "earlier-pause")
        .executeTakeFirstOrThrow();
      expect(receipt.result_state).toBe("paused");
      await expect(
        service.action(identity, machine.environmentId, "earlier-pause", { action: "pause" }),
      ).resolves.toMatchObject({ state: "running" });
      expect(pauses.mock.calls.length - before).toBe(1);
    } finally {
      vi.mocked(undici.fetch).mockImplementation(originalFetch);
      await service.action(identity, machine.environmentId, "cleanup-opposite", {
        action: "release",
      });
    }
  });

  it("defaults a machine Session without an explicit directory to /home/user", async () => {
    const machine = await service.create(identity, "default-machine-cwd", {
      name: "Default cwd",
      profileKey: "starter",
    });
    try {
      const session = await store.createSession(
        machine.projectId,
        machine.workspaceId,
        "default directory",
        "development_environment",
        { ownerUserId: identity.userId },
      );
      expect(session.workingDirectory).toBe("/home/user");
      expect(session.sandboxProfileKey).toBe("starter");
    } finally {
      await service.action(identity, machine.environmentId, "cleanup-default-cwd", {
        action: "release",
      });
    }
  });

  it("retires an abandoned pre-provision request without creating a Cube", async () => {
    const projectId = "77777777-7777-4777-8777-777777777701";
    const abandonedWorkspaceId = "77777777-7777-4777-8777-777777777702";
    const environmentId = "77777777-7777-4777-8777-777777777703";
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "Abandoned machine" })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("workspaces")
      .values({
        id: abandonedWorkspaceId,
        tenant_id: identity.tenantId,
        project_id: projectId,
        sandbox_domain_id: DOMAIN_ID,
        seed_kind: "empty",
        workspace_kind: "development_environment",
      })
      .executeTakeFirstOrThrow();
    await database
      .updateTable("sandbox_domains")
      .set({ assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} + 1` })
      .where("id", "=", DOMAIN_ID)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("development_environments")
      .values({
        id: environmentId,
        tenant_id: identity.tenantId,
        owner_user_id: identity.userId,
        project_id: projectId,
        workspace_id: abandonedWorkspaceId,
        sandbox_domain_id: DOMAIN_ID,
        environment_version_id: null,
        owner_instance_id: null,
        owner_base_url: null,
        runtime_id: null,
        runtime_name: null,
        state: "requested",
        failure_code: null,
        idempotency_key: "abandoned-machine",
        request_sha256: "a".repeat(64),
        profile_key: "starter",
        cpu_count: 1,
        memory_mib: 2_048,
        system_disk_gib: 8,
      })
      .executeTakeFirstOrThrow();

    await expect(service.reconcileLifecycle(new Date(Date.now() + 1_000))).resolves.toBe(1);
    await expect(
      database
        .selectFrom("development_environments as environment")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "environment.tenant_id")
            .onRef("workspace.id", "=", "environment.workspace_id"),
        )
        .select([
          "environment.state",
          "environment.failure_code as failureCode",
          "workspace.deleted_at as deletedAt",
        ])
        .where("environment.id", "=", environmentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "released",
      failureCode: "provision_request_abandoned",
      deletedAt: expect.any(Date),
    });
  });
});
