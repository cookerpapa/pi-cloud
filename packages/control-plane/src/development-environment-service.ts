import { createHash, randomUUID } from "node:crypto";
import type { Database, DevelopmentEnvironmentState } from "@pi-cloud/database";
import { environmentForImage } from "@pi-cloud/database";
import {
  SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_PATH,
  DEVELOPMENT_ENVIRONMENT_PROFILES,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseDevelopmentEnvironmentBrokerResponse,
  parseEnvironmentRuntimeSnapshot,
  type CreateDevelopmentEnvironmentDirectoryRequest,
  type CreateDevelopmentEnvironmentRequest,
  type DevelopmentEnvironmentActionRequest,
  type DevelopmentEnvironmentBrokerRequest,
  type DevelopmentEnvironmentProvisionRequest,
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentDirectoryResource,
  type DevelopmentEnvironmentResource,
} from "@pi-cloud/protocol";
import { createWorkspaceSeed, encodeWorkspaceBlob } from "@pi-cloud/workspace-runtime";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { Agent, fetch as internalFetch } from "undici";

const internalDispatcher = new Agent();

type MachineOwner = Pick<TenantRequestIdentity, "tenantId" | "userId">;

const MAXIMUM_ENVIRONMENTS = 100;
const MAXIMUM_REDIRECTS = 3;
const REQUEST_RECONCILE_INTERVAL_MS = 30_000;

export type DevelopmentEnvironmentServiceOptions = Readonly<{
  database: Kysely<Database>;
  terminalToken: string;
  allowInsecureInternalHttp: boolean;
  idGenerator?: () => string;
  environmentImageRevision?: string;
  observeMachine?(
    tenantId: string,
    userId: string,
    environmentId: string,
    allocationId: string,
  ): { state: "running" | "paused" | "unknown"; ipAddress?: string } | undefined;
}>;

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertGuestDirectoryPath(path: string): void {
  if (
    path.length < 1 ||
    path.length > 4_096 ||
    !path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new ControlPlaneStoreError("invalid_request", "Machine directory path is invalid");
  }
}

function profile(key: string) {
  const selected = DEVELOPMENT_ENVIRONMENT_PROFILES.find((candidate) => candidate.key === key);
  if (selected === undefined) {
    throw new ControlPlaneStoreError(
      "invalid_request",
      "Development environment profile is invalid",
    );
  }
  return selected;
}

function resource(
  row: {
    id: string;
    projectId: string;
    workspaceId: string;
    workspaceName: string;
    state: DevelopmentEnvironmentState;
    desiredState: "running" | "paused" | "released";
    generation: string;
    profileKey: string;
    cpuCount: number;
    memoryMiB: number;
    systemDiskGiB: number;
    failureCode: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    releasedAt: Date | string | null;
  },
  observation?: { state: "running" | "paused" | "unknown"; ipAddress?: string },
): DevelopmentEnvironmentResource {
  const generation = Number(row.generation);
  const selectedProfile = profile(row.profileKey);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Development environment generation is invalid",
    );
  }
  return {
    environmentId: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    desiredState: row.desiredState,
    state:
      row.state === "ready"
        ? (observation?.state ?? "unknown")
        : row.state === "reconciling"
          ? row.desiredState === "running"
            ? "recovering"
            : "unknown"
          : row.state,
    generation,
    profileKey: selectedProfile.key,
    cpuCount: row.cpuCount,
    memoryMiB: row.memoryMiB,
    systemDiskGiB: row.systemDiskGiB,
    ...(observation?.ipAddress ? { ipAddress: observation.ipAddress } : {}),
    ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(row.releasedAt === null ? {} : { releasedAt: new Date(row.releasedAt).toISOString() }),
  };
}

export class DevelopmentEnvironmentService {
  readonly #database: Kysely<Database>;
  readonly #terminalToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  readonly #id: () => string;
  readonly #environmentImageRevision: string;
  readonly #observeMachine: DevelopmentEnvironmentServiceOptions["observeMachine"];
  #reconcileTimer: NodeJS.Timeout | undefined;
  #reconciling: Promise<number> | undefined;

  constructor(options: DevelopmentEnvironmentServiceOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.terminalToken)) {
      throw new TypeError("Development environment service token is invalid");
    }
    this.#observeMachine = options.observeMachine;
    this.#database = options.database;
    this.#terminalToken = options.terminalToken;
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
    this.#id = options.idGenerator ?? randomUUID;
    this.#environmentImageRevision = options.environmentImageRevision ?? "development";
  }

  start(): void {
    if (this.#reconcileTimer !== undefined) return;
    void this.reconcileLifecycle().catch((error: unknown) => {
      process.stderr.write(
        `Development environment reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    });
    this.#reconcileTimer = setInterval(() => {
      void this.reconcileLifecycle().catch((error: unknown) => {
        process.stderr.write(
          `Development environment reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      });
    }, REQUEST_RECONCILE_INTERVAL_MS);
    this.#reconcileTimer.unref();
  }

  async close(): Promise<void> {
    if (this.#reconcileTimer !== undefined) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
    await this.#reconciling;
  }

  async reconcileLifecycle(limit = 16): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new TypeError("Invalid machine reconciliation batch");
    if (this.#reconciling) return this.#reconciling;
    const pending = this.#reconcileLifecycle(limit).finally(() => {
      if (this.#reconciling === pending) this.#reconciling = undefined;
    });
    this.#reconciling = pending;
    return pending;
  }

  async #reconcileLifecycle(limit: number): Promise<number> {
    const requested = await this.#database
      .selectFrom("development_environments")
      .select(["id", "tenant_id as tenantId", "owner_user_id as userId"])
      .where("state", "=", "requested")
      .where("desired_state", "=", "running")
      .orderBy("updated_at", "asc")
      .limit(limit)
      .execute();
    let completed = 0;
    for (const machine of requested) {
      try {
        await this.#provision(machine, machine.id);
        completed += 1;
      } catch {
        /* Durable intent remains pending. */
      }
    }
    const releasing = await this.#database
      .selectFrom("development_environments as machine")
      .innerJoin("workspaces as workspace", "workspace.id", "machine.workspace_id")
      .select([
        "machine.id",
        "machine.tenant_id as tenantId",
        "machine.owner_user_id as userId",
        "machine.state",
        "machine.intent_revision as revision",
      ])
      .where("machine.desired_state", "=", "released")
      .where((eb) =>
        eb.or([eb("machine.state", "!=", "released"), eb("workspace.deleted_at", "is", null)]),
      )
      .orderBy("machine.updated_at", "asc")
      .limit(limit)
      .execute();
    for (const machine of releasing) {
      try {
        const state =
          machine.state === "released"
            ? "released"
            : await this.#lifecycle(machine, machine.id, "release", Number(machine.revision));
        if (state !== "released") continue;
        await this.#retireReleasedMachineWorkspace(machine, machine.id);
        await this.#database
          .updateTable("development_environment_operations")
          .set({ result_state: "released" })
          .where("tenant_id", "=", machine.tenantId)
          .where("environment_id", "=", machine.id)
          .where("action", "=", "release")
          .where("intent_revision", "<=", machine.revision)
          .where("result_state", "!=", "released")
          .execute();
        completed += 1;
      } catch {
        /* Closing intent and physical target survive the failed call. */
      }
    }
    return completed;
  }

  async list(identity: TenantRequestIdentity): Promise<DevelopmentEnvironmentListResource> {
    const rows = await this.#baseQuery(identity)
      .where("development.state", "!=", "released")
      .orderBy("development.updated_at", "desc")
      .orderBy("development.id", "desc")
      .limit(MAXIMUM_ENVIRONMENTS + 1)
      .execute();
    return {
      environments: await Promise.all(
        rows.slice(0, MAXIMUM_ENVIRONMENTS).map((row) => this.#resource(identity, row)),
      ),
      profiles: DEVELOPMENT_ENVIRONMENT_PROFILES.map((candidate) => ({
        ...candidate,
        recommended: candidate.key === "standard",
      })),
      truncated: rows.length > MAXIMUM_ENVIRONMENTS,
    };
  }

  async get(
    identity: MachineOwner,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentResource> {
    const row = await this.#baseQuery(identity)
      .where("development.id", "=", environmentId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Development environment was not found");
    }
    return this.#resource(identity, row);
  }

  async directory(
    identity: TenantRequestIdentity,
    environmentId: string,
    path: string,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    assertGuestDirectoryPath(path);
    const environment = await this.get(identity, environmentId);
    if (environment.state !== "running") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Exclusive machine must be running before browsing its filesystem",
      );
    }
    const descriptor = await this.#machineRoute(identity, environmentId);
    const result = await this.#send(descriptor.domainId, descriptor.sandboxControlBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.directory",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      path,
    });
    if (result.type !== "development_environment.directory") {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Sandbox control returned the wrong machine directory response",
      );
    }
    return { environmentId, path: result.path, entries: result.entries };
  }

  async createDirectory(
    identity: TenantRequestIdentity,
    environmentId: string,
    request: CreateDevelopmentEnvironmentDirectoryRequest,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    assertGuestDirectoryPath(request.path);
    const environment = await this.get(identity, environmentId);
    if (environment.state !== "running") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Exclusive machine must be running before changing its filesystem",
      );
    }
    const descriptor = await this.#machineRoute(identity, environmentId);
    const result = await this.#send(descriptor.domainId, descriptor.sandboxControlBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.create_directory",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      path: request.path,
      name: request.name,
    });
    if (result.type !== "development_environment.directory") {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Sandbox control returned the wrong machine directory response",
      );
    }
    return { environmentId, path: result.path, entries: result.entries };
  }

  async create(
    identity: TenantRequestIdentity,
    idempotencyKey: string,
    request: CreateDevelopmentEnvironmentRequest,
  ): Promise<DevelopmentEnvironmentResource> {
    const fingerprint = requestHash(request);
    const environmentId = await this.#database.transaction().execute(async (transaction) => {
      // Admission and replay must observe the same serialized tenant state.
      // Checking replay first lets concurrent requests both create a Project.
      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select("maximum_projects")
        .where("tenant_id", "=", identity.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (policy === undefined) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Tenant project capacity policy is unavailable",
        );
      }
      const replay = await transaction
        .selectFrom("development_environments")
        .select(["id", "request_sha256"])
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency key was reused for another development environment",
          );
        }
        return replay.id;
      }
      const id = this.#id();
      const projectId = this.#id();
      const workspaceId = this.#id();
      const environmentVersionId = this.#id();
      const selectedProfile = profile(request.profileKey);
      if (policy.maximum_projects !== null) {
        const projectCountRow = await transaction
          .selectFrom("projects")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenant_id", "=", identity.tenantId)
          .where("deleted_at", "is", null)
          .executeTakeFirstOrThrow();
        const projectCount = Number(projectCountRow.count);
        if (!Number.isSafeInteger(projectCount) || projectCount < 0) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Tenant project count is invalid",
          );
        }
        if (projectCount >= policy.maximum_projects) {
          throw new ControlPlaneStoreError(
            "tenant_quota_exceeded",
            "Tenant project quota has been reached",
          );
        }
      }
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select(["id", "assigned_workspaces", "maximum_active_sandboxes"])
        .where("state", "=", "active")
        .orderBy(
          sql<number>`(${sql.ref("assigned_workspaces")}::numeric / ${sql.ref("maximum_active_sandboxes")})`,
          "asc",
        )
        .orderBy("id", "asc")
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "No active Sandbox Domain is available",
        );
      }
      await transaction
        .updateTable("sandbox_domains")
        .set({
          assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} + 1`,
          updated_at: new Date(),
        })
        .where("id", "=", domain.id)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("projects")
        .values({
          id: projectId,
          tenant_id: identity.tenantId,
          name: request.name,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("workspaces")
        .values({
          id: workspaceId,
          tenant_id: identity.tenantId,
          project_id: projectId,
          sandbox_domain_id: domain.id,
          seed_kind: "empty",
          workspace_kind: "development_environment",
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("environment_versions")
        .values({
          id: environmentVersionId,
          tenant_id: identity.tenantId,
          project_id: projectId,
          version_number: 1,
          profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
          profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
          image_revision: this.#environmentImageRevision,
          spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
          recipe: sql<Record<string, unknown>>`${JSON.stringify(
            DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          )}::jsonb`,
          recipe_sha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
          state: "pending",
          active: true,
          validated_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("development_environments")
        .values({
          id,
          tenant_id: identity.tenantId,
          owner_user_id: identity.userId,
          project_id: projectId,
          workspace_id: workspaceId,
          sandbox_domain_id: domain.id,
          environment_version_id: environmentVersionId,
          owner_instance_id: null,
          owner_base_url: null,
          runtime_id: null,
          runtime_name: null,
          profile_key: selectedProfile.key,
          cpu_count: selectedProfile.cpuCount,
          memory_mib: selectedProfile.memoryMiB,
          system_disk_gib: selectedProfile.systemDiskGiB,
          state: "requested",
          failure_code: null,
          idempotency_key: idempotencyKey,
          request_sha256: fingerprint,
          released_at: null,
        })
        .executeTakeFirstOrThrow();
      return id;
    });
    try {
      await this.#provision(identity, environmentId);
    } catch (error) {
      if (error instanceof ControlPlaneStoreError && error.code === "capacity_exhausted") {
        // A refused reservation has issued no Cube request. Keep uncertain
        // creations retryable; only this proved pre-effect refusal is retired.
        const rejected = await this.#database
          .updateTable("development_environments")
          .set({
            desired_state: "released",
            intent_revision: sql<string>`intent_revision+1`,
            state: "released",
            allocation_closed: true,
            allocation_absent: true,
            failure_code: error.code,
            released_at: new Date(),
            updated_at: new Date(),
          })
          .where("id", "=", environmentId)
          .where("tenant_id", "=", identity.tenantId)
          .where("state", "=", "requested")
          .where("owner_instance_id", "is", null)
          .where("creation_spec", "is", null)
          .executeTakeFirst();
        if (rejected.numUpdatedRows === 1n)
          await this.#retireReleasedMachineWorkspace(identity, environmentId);
        throw error;
      }
      // Accepted intent is retried by reconciliation.
    }
    return this.get(identity, environmentId);
  }

  async action(
    identity: MachineOwner,
    environmentId: string,
    idempotencyKey: string,
    request: DevelopmentEnvironmentActionRequest,
  ): Promise<DevelopmentEnvironmentResource> {
    const fingerprint = requestHash(request);
    const accepted = await this.#database.transaction().execute(async (tx) => {
      const machine = await tx
        .selectFrom("development_environments")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirst();
      if (!machine)
        throw new ControlPlaneStoreError("not_found", "Development environment was not found");
      const prior = await tx
        .selectFrom("development_environment_operations")
        .select(["request_sha256", "intent_revision"])
        .where("tenant_id", "=", identity.tenantId)
        .where("environment_id", "=", environmentId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (prior) {
        if (prior.request_sha256 !== fingerprint)
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency key was reused for another machine action",
          );
        return {
          revision: Number(prior.intent_revision),
          pending:
            prior.intent_revision === machine.intent_revision && machine.state !== "released",
        };
      }
      if (machine.desired_state === "released" && request.action !== "release")
        throw new ControlPlaneStoreError(
          "conflict",
          "Development machine release has been requested",
        );
      const active = await tx
        .selectFrom("runs")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", machine.workspace_id)
        .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
        .limit(1)
        .executeTakeFirst();
      if (active || machine.agent_activation_id || machine.terminal_active)
        throw new ControlPlaneStoreError(
          "conflict",
          "Wait for the active Agent Run or terminal before changing the machine",
        );
      const desired =
        request.action === "pause"
          ? "paused"
          : request.action === "resume"
            ? "running"
            : "released";
      const revision = Number(machine.intent_revision) + 1;
      const neverIssued = machine.creation_spec === null && machine.owner_instance_id === null;
      const released = desired === "released" && (machine.state === "released" || neverIssued);
      await tx
        .updateTable("development_environments")
        .set({
          desired_state: desired,
          intent_revision: String(revision),
          state: released
            ? "released"
            : machine.state === "requested"
              ? "requested"
              : desired === "released"
                ? "releasing"
                : "reconciling",
          ...(released
            ? { allocation_closed: true, allocation_absent: true, released_at: new Date() }
            : {}),
          updated_at: new Date(),
        })
        .where("id", "=", environmentId)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("development_environment_operations")
        .values({
          id: this.#id(),
          tenant_id: identity.tenantId,
          environment_id: environmentId,
          actor_user_id: identity.userId,
          idempotency_key: idempotencyKey,
          action: request.action,
          request_sha256: fingerprint,
          intent_revision: String(revision),
          result_state: released ? "released" : "requested",
        })
        .executeTakeFirstOrThrow();
      return { revision, pending: !released && machine.state !== "requested" };
    });
    if (accepted.pending) {
      try {
        const result = await this.#lifecycle(
          identity,
          environmentId,
          request.action,
          accepted.revision,
        );
        await this.#database
          .updateTable("development_environment_operations")
          .set({ result_state: result })
          .where("tenant_id", "=", identity.tenantId)
          .where("environment_id", "=", environmentId)
          .where("idempotency_key", "=", idempotencyKey)
          .where("intent_revision", "=", String(accepted.revision))
          .execute();
      } catch {
        /* The committed current intent is completed by the controller, never forgotten. */
      }
    }
    const current = await this.get(identity, environmentId);
    if (current.state === "released")
      await this.#retireReleasedMachineWorkspace(identity, environmentId);
    return current;
  }

  async #retireReleasedMachineWorkspace(
    identity: Readonly<{ tenantId: string; userId: string }>,
    environmentId: string,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const environment = await transaction
        .selectFrom("development_environments")
        .select(["state", "project_id", "workspace_id", "sandbox_domain_id"])
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (environment.state !== "released") {
        throw new ControlPlaneStoreError(
          "conflict",
          "Development environment must be released before deleting its machine storage",
        );
      }
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["workspace_kind", "deleted_at"])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", environment.workspace_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (workspace.workspace_kind !== "development_environment") {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Development environment storage identity is invalid",
        );
      }
      if (workspace.deleted_at !== null) return;

      const activeTurn = await transaction
        .selectFrom("runs as run")
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "run.tenant_id")
            .onRef("session_row.id", "=", "run.session_id"),
        )
        .select("run.id")
        .where("run.tenant_id", "=", identity.tenantId)
        .where("session_row.workspace_id", "=", environment.workspace_id)
        .where("run.state", "in", ["queued", "running", "settling", "cancel_requested"])
        .limit(1)
        .executeTakeFirst();
      if (activeTurn !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Wait for every conversation Run to settle before deleting the development machine",
        );
      }
      const detached = await transaction
        .selectFrom("sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", environment.workspace_id)
        .where("session_kind", "=", "conversation")
        .where("pruned_at", "is", null)
        .executeTakeFirstOrThrow();
      const detachedSessionCount = Number(detached.count);
      if (!Number.isSafeInteger(detachedSessionCount) || detachedSessionCount < 0) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Development environment conversation count is invalid",
        );
      }

      const deletedAt = new Date();
      await transaction
        .updateTable("workspaces")
        .set({
          deleted_at: deletedAt,
          updated_at: deletedAt,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", environment.workspace_id)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sandbox_domains")
        .set({
          assigned_workspaces: sql<string>`greatest(${sql.ref("assigned_workspaces")} - 1, 0)`,
          updated_at: deletedAt,
        })
        .where("id", "=", environment.sandbox_domain_id)
        .executeTakeFirstOrThrow();
      const remainingWorkspace = await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("project_id", "=", environment.project_id)
        .where("deleted_at", "is", null)
        .limit(1)
        .executeTakeFirst();
      if (remainingWorkspace === undefined) {
        await transaction
          .updateTable("projects")
          .set({ deleted_at: deletedAt, updated_at: deletedAt })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", environment.project_id)
          .where("deleted_at", "is", null)
          .executeTakeFirst();
      }
      await transaction
        .insertInto("workspace_delete_operations")
        .values({
          operation_id: this.#id(),
          tenant_id: identity.tenantId,
          workspace_id: environment.workspace_id,
          idempotency_key: `development-environment:${environmentId}:release`,
          deleted_at: deletedAt,
          detached_session_count: detachedSessionCount,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async #resource(
    identity: MachineOwner,
    row: Parameters<typeof resource>[0] & {
      allocationId: string;
      ownerBaseUrl: string | null;
      domainId: string;
    },
  ): Promise<DevelopmentEnvironmentResource> {
    let observation = this.#observeMachine?.(
      identity.tenantId,
      identity.userId,
      row.id,
      row.allocationId,
    );
    if (!observation && row.ownerBaseUrl && row.state === "ready") {
      try {
        const result = await this.#send(row.domainId, row.ownerBaseUrl, {
          developmentEnvironmentProtocolVersion: 1,
          type: "development_environment.observe",
          requestId: this.#id(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          environmentId: row.id,
          allocationId: row.allocationId,
        });
        if (
          result.type === "development_environment.state" &&
          ["running", "paused", "unknown"].includes(result.state)
        )
          observation = {
            state: result.state as "running" | "paused" | "unknown",
            ...(result.ipAddress ? { ipAddress: result.ipAddress } : {}),
          };
      } catch {
        /* The product remains readable while Cube or its owner is unavailable. */
      }
    }
    return resource(row, observation);
  }

  #baseQuery(identity: MachineOwner) {
    return this.#database
      .selectFrom("development_environments as development")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "development.tenant_id")
          .onRef("project.id", "=", "development.project_id"),
      )
      .select([
        "development.id",
        "development.project_id as projectId",
        "development.workspace_id as workspaceId",
        "project.name as workspaceName",
        "development.state",
        "development.desired_state as desiredState",
        "development.allocation_id as allocationId",
        "development.owner_base_url as ownerBaseUrl",
        "development.sandbox_domain_id as domainId",
        "development.generation",
        "development.allocation_id as allocationId",
        "development.intent_revision as intentRevision",
        "development.profile_key as profileKey",
        "development.cpu_count as cpuCount",
        "development.memory_mib as memoryMiB",
        "development.system_disk_gib as systemDiskGiB",
        "development.failure_code as failureCode",
        "development.created_at as createdAt",
        "development.updated_at as updatedAt",
        "development.released_at as releasedAt",
      ])
      .where("development.tenant_id", "=", identity.tenantId)
      .where("development.owner_user_id", "=", identity.userId);
  }

  async #provision(identity: MachineOwner, environmentId: string): Promise<void> {
    const descriptor = await this.#provisionDescriptor(identity, environmentId);
    await this.#send(descriptor.domainId, descriptor.sandboxControlBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: this.#id(),
      environmentId,
      allocationId: descriptor.allocationId,
      intentRevision: descriptor.intentRevision,
      tenantId: identity.tenantId,
      userId: identity.userId,
      projectId: descriptor.projectId,
      workspaceId: descriptor.workspaceId,
      generation: descriptor.generation,
      profileKey: descriptor.profileKey,
      environment: descriptor.environment,
      workspaceSeed: descriptor.workspaceSeed,
    });
  }

  async #lifecycle(
    identity: MachineOwner,
    environmentId: string,
    action: "pause" | "resume" | "release",
    intentRevision: number,
  ) {
    const descriptor = await this.#machineRoute(identity, environmentId);
    const response = await this.#send(descriptor.domainId, descriptor.sandboxControlBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      intentRevision,
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      action,
    });
    if (
      response.type !== "development_environment.state" ||
      response.environmentId !== environmentId
    )
      throw new ControlPlaneStoreError(
        "conflict",
        "Sandbox control did not confirm the requested environment state",
      );
    return response.state;
  }

  // Managing existing compute is independent of whether the Domain/profile is
  // accepting new allocations. Ownership and the Broker's effect checks remain.
  async #machineRoute(identity: MachineOwner, environmentId: string) {
    const route = await this.#database
      .selectFrom("development_environments as machine")
      .innerJoin("sandbox_domains as domain", "domain.id", "machine.sandbox_domain_id")
      .select(["domain.id as domainId", "domain.sandbox_control_base_url as sandboxControlBaseUrl"])
      .where("machine.tenant_id", "=", identity.tenantId)
      .where("machine.owner_user_id", "=", identity.userId)
      .where("machine.id", "=", environmentId)
      .executeTakeFirst();
    if (!route)
      throw new ControlPlaneStoreError("not_found", "Development environment was not found");
    return route;
  }

  async #provisionDescriptor(
    identity: MachineOwner,
    environmentId: string,
  ): Promise<
    Omit<
      DevelopmentEnvironmentProvisionRequest,
      | "developmentEnvironmentProtocolVersion"
      | "type"
      | "requestId"
      | "environmentId"
      | "tenantId"
      | "userId"
    > & { domainId: string; sandboxControlBaseUrl: string }
  > {
    const row = await this.#database
      .selectFrom("development_environments as development")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "development.tenant_id")
          .onRef("workspace.id", "=", "development.workspace_id"),
      )
      .innerJoin("sandbox_domains as domain", "domain.id", "development.sandbox_domain_id")
      .innerJoin("environment_versions as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "workspace.tenant_id")
          .onRef("environment.project_id", "=", "workspace.project_id")
          .on("environment.active", "=", true),
      )
      .select([
        "workspace.project_id as projectId",
        "workspace.id as workspaceId",
        "domain.id as domainId",
        "domain.sandbox_control_base_url as sandboxControlBaseUrl",
        "development.generation",
        "development.allocation_id as allocationId",
        "development.intent_revision as intentRevision",
        "development.profile_key as profileKey",
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
      ])
      .where("development.tenant_id", "=", identity.tenantId)
      .where("development.owner_user_id", "=", identity.userId)
      .where("development.id", "=", environmentId)
      .where("workspace.workspace_kind", "=", "development_environment")
      .where("workspace.deleted_at", "is", null)
      .where("domain.state", "=", "active")
      .executeTakeFirst();
    if (row === undefined || row.environmentState === "failed") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Development environment runtime profile is unavailable",
      );
    }
    if (row.environmentImageRevision !== this.#environmentImageRevision) {
      await this.#database.transaction().execute(async (tx) => {
        const result = await environmentForImage(tx, {
          tenantId: identity.tenantId,
          projectId: row.projectId,
          imageRevision: this.#environmentImageRevision,
          id: this.#id,
        });
        if (result.status !== "ready")
          throw new ControlPlaneStoreError(
            "conflict",
            "Machine environment configuration is unavailable",
          );
      });
      return this.#provisionDescriptor(identity, environmentId);
    }
    const generation = Number(row.generation);
    const selectedProfile = profile(row.profileKey);
    return {
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      domainId: row.domainId,
      sandboxControlBaseUrl: row.sandboxControlBaseUrl,
      generation,
      allocationId: row.allocationId,
      intentRevision: Number(row.intentRevision),
      profileKey: selectedProfile.key,
      environment: parseEnvironmentRuntimeSnapshot({
        environmentVersionId: row.environmentVersionId,
        versionNumber: row.environmentVersionNumber,
        profileKey: row.environmentProfileKey,
        profileVersion: row.environmentProfileVersion,
        imageRevision: row.environmentImageRevision,
        specSha256: row.environmentSpecSha256,
        recipe: row.environmentRecipe,
        recipeSha256: row.environmentRecipeSha256,
      }),
      workspaceSeed: {
        kind: "bundle" as const,
        bundle: encodeWorkspaceBlob(createWorkspaceSeed([])),
      },
    };
  }

  async #send(
    domainId: string,
    initialBaseUrl: string,
    message: DevelopmentEnvironmentBrokerRequest,
  ): Promise<import("@pi-cloud/protocol").DevelopmentEnvironmentBrokerResponse> {
    let baseUrl = initialBaseUrl;
    for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
      const target = new URL(SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_PATH, baseUrl);
      if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
        throw new Error("Insecure Sandbox control development environment URL was rejected");
      }
      const response = await internalFetch(target, {
        dispatcher: internalDispatcher,
        redirect: "error",
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#terminalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(
          message.type === "development_environment.observe" ? 1500 : 120_000,
        ),
      });
      const body = (await response.json()) as unknown;
      if (!response.ok) {
        const safeError =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null
            ? (body.error as { code?: unknown; message?: unknown })
            : undefined;
        const message =
          typeof safeError?.message === "string" && safeError.message.length <= 1_024
            ? safeError.message
            : "Development environment operation was rejected by Sandbox control";
        const code =
          safeError?.code === "sandbox_domain_capacity_exhausted" ||
          safeError?.code === "sandbox_compute_capacity_exhausted"
            ? "capacity_exhausted"
            : response.status === 409
              ? "conflict"
              : "control_plane_misconfigured";
        throw new ControlPlaneStoreError(code, message);
      }
      const parsed = parseDevelopmentEnvironmentBrokerResponse(body);
      if (parsed.type === "development_environment.owner_redirect") {
        baseUrl = await this.#validatedOwnerRedirect(domainId, parsed.ownerBaseUrl);
        continue;
      }
      return parsed;
    }
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Development environment exceeded the Sandbox control redirect limit",
    );
  }

  async #validatedOwnerRedirect(domainId: string, ownerBaseUrl: string): Promise<string> {
    const normalized = new URL(ownerBaseUrl).toString();
    const owner = await this.#database
      .selectFrom("sandbox_control_instances")
      .select("owner_base_url")
      .where("sandbox_domain_id", "=", domainId)
      .where("owner_base_url", "=", normalized)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", new Date())
      .executeTakeFirst();
    if (owner === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Development environment Sandbox control redirect was stale",
      );
    }
    return owner.owner_base_url;
  }
}
