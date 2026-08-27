import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import {
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH,
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
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentDirectoryResource,
  type DevelopmentEnvironmentResource,
} from "@pi-cloud/protocol";
import { createWorkspaceSnapshot, encodeWorkspaceSnapshotBlob } from "@pi-cloud/workspace-runtime";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const MAXIMUM_ENVIRONMENTS = 100;
const MAXIMUM_REDIRECTS = 3;
const ABANDONED_REQUEST_AGE_MS = 5 * 60_000;
const REQUEST_RECONCILE_INTERVAL_MS = 30_000;

export type DevelopmentEnvironmentServiceOptions = Readonly<{
  database: Kysely<Database>;
  terminalToken: string;
  allowInsecureInternalHttp: boolean;
  idGenerator?: () => string;
  environmentImageRevision?: string;
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

function resource(row: {
  id: string;
  projectId: string;
  workspaceId: string;
  workspaceName: string;
  state: DevelopmentEnvironmentResource["state"];
  generation: string;
  profileKey: string;
  cpuCount: number;
  memoryMiB: number;
  systemDiskGiB: number;
  failureCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  releasedAt: Date | string | null;
  ipAddress: string | null;
}): DevelopmentEnvironmentResource {
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
    state: row.state,
    generation,
    profileKey: selectedProfile.key,
    cpuCount: row.cpuCount,
    memoryMiB: row.memoryMiB,
    systemDiskGiB: row.systemDiskGiB,
    ...(row.ipAddress === null ? {} : { ipAddress: row.ipAddress }),
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
  #reconcileTimer: NodeJS.Timeout | undefined;
  #reconciling: Promise<number> | undefined;

  constructor(options: DevelopmentEnvironmentServiceOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.terminalToken)) {
      throw new TypeError("Development environment service token is invalid");
    }
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

  async reconcileLifecycle(
    cutoff = new Date(Date.now() - ABANDONED_REQUEST_AGE_MS),
    limit = 16,
  ): Promise<number> {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.valueOf())) {
      throw new TypeError("Development environment reconciliation cutoff is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Development environment reconciliation limit is invalid");
    }
    if (this.#reconciling !== undefined) return this.#reconciling;
    const running = this.#reconcileLifecycle(cutoff, limit).finally(() => {
      if (this.#reconciling === running) this.#reconciling = undefined;
    });
    this.#reconciling = running;
    return running;
  }

  async #reconcileLifecycle(cutoff: Date, limit: number): Promise<number> {
    const abandoned = await this.#database
      .selectFrom("development_environments")
      .select(["id", "tenant_id as tenantId", "owner_user_id as userId"])
      .where("state", "=", "requested")
      .where("updated_at", "<", cutoff)
      .orderBy("updated_at", "asc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
    let retired = 0;
    for (const environment of abandoned) {
      const retiredAt = new Date();
      const update = await this.#database
        .updateTable("development_environments")
        .set({
          state: "released",
          failure_code: "provision_request_abandoned",
          released_at: retiredAt,
          updated_at: retiredAt,
        })
        .where("tenant_id", "=", environment.tenantId)
        .where("owner_user_id", "=", environment.userId)
        .where("id", "=", environment.id)
        .where("state", "=", "requested")
        .where("updated_at", "<", cutoff)
        .executeTakeFirst();
      if (update.numUpdatedRows !== 1n) continue;
      await this.#retireReleasedMachineWorkspace(environment, environment.id);
      retired += 1;
    }
    const incompleteReleases = await this.#database
      .selectFrom("development_environments as environment")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "environment.tenant_id")
          .onRef("workspace.id", "=", "environment.workspace_id"),
      )
      .select([
        "environment.id",
        "environment.tenant_id as tenantId",
        "environment.owner_user_id as userId",
      ])
      .where("environment.state", "=", "released")
      .where("workspace.workspace_kind", "=", "development_environment")
      .where("workspace.deleted_at", "is", null)
      .orderBy("environment.released_at", "asc")
      .orderBy("environment.id", "asc")
      .limit(limit)
      .execute();
    for (const environment of incompleteReleases) {
      await this.#retireReleasedMachineWorkspace(environment, environment.id);
      retired += 1;
    }
    return retired;
  }

  async list(identity: TenantRequestIdentity): Promise<DevelopmentEnvironmentListResource> {
    const rows = await this.#baseQuery(identity)
      .where("development.state", "!=", "released")
      .orderBy("development.updated_at", "desc")
      .orderBy("development.id", "desc")
      .limit(MAXIMUM_ENVIRONMENTS + 1)
      .execute();
    return {
      environments: rows.slice(0, MAXIMUM_ENVIRONMENTS).map(resource),
      profiles: DEVELOPMENT_ENVIRONMENT_PROFILES.map((candidate) => ({
        ...candidate,
        recommended: candidate.key === "standard",
      })),
      truncated: rows.length > MAXIMUM_ENVIRONMENTS,
    };
  }

  async get(
    identity: TenantRequestIdentity,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentResource> {
    const row = await this.#baseQuery(identity)
      .where("development.id", "=", environmentId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Development environment was not found");
    }
    return resource(row);
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
    const descriptor = await this.#descriptor(identity, environmentId);
    const result = await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
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
        "Tool Broker returned the wrong machine directory response",
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
    const descriptor = await this.#descriptor(identity, environmentId);
    const result = await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
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
        "Tool Broker returned the wrong machine directory response",
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
          environment_version_id: null,
          owner_instance_id: null,
          owner_base_url: null,
          runtime_id: null,
          runtime_name: null,
          ip_address: null,
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
    } catch (error: unknown) {
      await this.#rejectUnprovisionedEnvironment(identity, environmentId, error).catch(
        () => undefined,
      );
      throw error;
    }
    return this.get(identity, environmentId);
  }

  async action(
    identity: TenantRequestIdentity,
    environmentId: string,
    idempotencyKey: string,
    request: DevelopmentEnvironmentActionRequest,
  ): Promise<DevelopmentEnvironmentResource> {
    const fingerprint = requestHash(request);
    const replayed = await this.#database.transaction().execute(async (transaction) => {
      const environment = await transaction
        .selectFrom("development_environments")
        .select([
          "state",
          "workspace_id as workspaceId",
          "agent_activation_id as agentActivationId",
          "terminal_active as terminalActive",
        ])
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirst();
      if (environment === undefined) {
        throw new ControlPlaneStoreError("not_found", "Development environment was not found");
      }
      const replay = await transaction
        .selectFrom("development_environment_operations")
        .select("request_sha256")
        .where("tenant_id", "=", identity.tenantId)
        .where("environment_id", "=", environmentId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency key was reused for another environment action",
          );
        }
        return true;
      }
      const alreadyReleased = request.action === "release" && environment.state === "released";
      const allowed =
        (request.action === "pause" && environment.state === "running") ||
        (request.action === "resume" && environment.state === "paused") ||
        alreadyReleased ||
        (request.action === "release" &&
          ["requested", "running", "paused", "failed", "unknown"].includes(environment.state));
      if (!allowed) {
        throw new ControlPlaneStoreError(
          "conflict",
          `Development environment cannot ${request.action} from ${environment.state}`,
        );
      }
      if (request.action === "release" && !alreadyReleased) {
        const activeRun = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", identity.tenantId)
          .where("workspace_id", "=", environment.workspaceId)
          .where("state", "in", ["claimed", "running", "cancel_requested"])
          .limit(1)
          .executeTakeFirst();
        if (
          activeRun !== undefined ||
          environment.agentActivationId !== null ||
          environment.terminalActive
        ) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the active Agent Run or terminal before releasing the environment",
          );
        }
      }
      await transaction
        .insertInto("development_environment_operations")
        .values({
          id: this.#id(),
          tenant_id: identity.tenantId,
          environment_id: environmentId,
          actor_user_id: identity.userId,
          idempotency_key: idempotencyKey,
          action: request.action,
          request_sha256: fingerprint,
          result_state: environment.state,
        })
        .executeTakeFirstOrThrow();
      return alreadyReleased;
    });
    if (!replayed) {
      if (request.action === "release") {
        const current = await this.get(identity, environmentId);
        if (current.state === "requested" || current.state === "failed") {
          await this.#database
            .updateTable("development_environments")
            .set({
              state: "released",
              owner_instance_id: null,
              owner_base_url: null,
              runtime_id: null,
              runtime_name: null,
              runtime_capsule: null,
              released_at: new Date(),
              updated_at: new Date(),
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("owner_user_id", "=", identity.userId)
            .where("id", "=", environmentId)
            .executeTakeFirstOrThrow();
        } else {
          await this.#lifecycle(identity, environmentId, request.action);
        }
      } else {
        await this.#lifecycle(identity, environmentId, request.action);
      }
      const settled = await this.get(identity, environmentId);
      await this.#database
        .updateTable("development_environment_operations")
        .set({ result_state: settled.state })
        .where("tenant_id", "=", identity.tenantId)
        .where("environment_id", "=", environmentId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirstOrThrow();
    }
    if (request.action === "release") {
      await this.#retireReleasedMachineWorkspace(identity, environmentId);
    }
    return this.get(identity, environmentId);
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
        .selectFrom("turns as turn")
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "turn.tenant_id")
            .onRef("session_row.id", "=", "turn.session_id"),
        )
        .select("turn.id")
        .where("turn.tenant_id", "=", identity.tenantId)
        .where("session_row.workspace_id", "=", environment.workspace_id)
        .where("turn.state", "in", ["queued", "dispatching", "running", "cancelling"])
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
        .where("archived_at", "is", null)
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

  async #rejectUnprovisionedEnvironment(
    identity: TenantRequestIdentity,
    environmentId: string,
    error: unknown,
  ): Promise<void> {
    const rejectedAt = new Date();
    const failureCode =
      error instanceof ControlPlaneStoreError ? error.code : "provision_request_failed";
    const released = await this.#database
      .updateTable("development_environments")
      .set({
        state: "released",
        owner_instance_id: null,
        owner_base_url: null,
        environment_version_id: null,
        runtime_id: null,
        runtime_name: null,
        runtime_capsule: null,
        failure_code: failureCode,
        released_at: rejectedAt,
        updated_at: rejectedAt,
      })
      .where("tenant_id", "=", identity.tenantId)
      .where("owner_user_id", "=", identity.userId)
      .where("id", "=", environmentId)
      .where("state", "in", ["requested", "failed"])
      .where("runtime_id", "is", null)
      .where("runtime_name", "is", null)
      .where("agent_activation_id", "is", null)
      .where("terminal_active", "=", false)
      .executeTakeFirst();
    if (released.numUpdatedRows === 1n) {
      await this.#retireReleasedMachineWorkspace(identity, environmentId);
    }
  }

  #baseQuery(identity: TenantRequestIdentity) {
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
        "development.generation",
        "development.profile_key as profileKey",
        "development.cpu_count as cpuCount",
        "development.memory_mib as memoryMiB",
        "development.system_disk_gib as systemDiskGiB",
        "development.ip_address as ipAddress",
        "development.failure_code as failureCode",
        "development.created_at as createdAt",
        "development.updated_at as updatedAt",
        "development.released_at as releasedAt",
      ])
      .where("development.tenant_id", "=", identity.tenantId)
      .where("development.owner_user_id", "=", identity.userId);
  }

  async #provision(identity: TenantRequestIdentity, environmentId: string): Promise<void> {
    const descriptor = await this.#descriptor(identity, environmentId);
    const result = await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      projectId: descriptor.projectId,
      workspaceId: descriptor.workspaceId,
      generation: descriptor.generation,
      profileKey: descriptor.profileKey,
      environment: descriptor.environment,
      workspaceSeed: descriptor.workspaceSeed,
    });
    if (result.type === "development_environment.state" && result.ipAddress !== undefined) {
      await this.#database
        .updateTable("development_environments")
        .set({ ip_address: result.ipAddress, updated_at: new Date() })
        .where("tenant_id", "=", identity.tenantId)
        .where("owner_user_id", "=", identity.userId)
        .where("id", "=", environmentId)
        .executeTakeFirstOrThrow();
    }
  }

  async #lifecycle(
    identity: TenantRequestIdentity,
    environmentId: string,
    action: "pause" | "resume" | "release",
  ): Promise<void> {
    const descriptor = await this.#descriptor(identity, environmentId);
    await this.#send(descriptor.domainId, descriptor.toolBrokerBaseUrl, {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: this.#id(),
      environmentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      action,
    });
  }

  async #descriptor(identity: TenantRequestIdentity, environmentId: string) {
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
        "domain.tool_broker_base_url as toolBrokerBaseUrl",
        "development.generation",
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
    const generation = Number(row.generation);
    const selectedProfile = profile(row.profileKey);
    return {
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      domainId: row.domainId,
      toolBrokerBaseUrl: row.toolBrokerBaseUrl,
      generation,
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
        kind: "snapshot" as const,
        snapshot: encodeWorkspaceSnapshotBlob(createWorkspaceSnapshot([])),
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
      const target = new URL(TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH, baseUrl);
      if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
        throw new Error("Insecure Tool Broker development environment URL was rejected");
      }
      const response = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#terminalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(120_000),
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
            : "Development environment operation was rejected by Tool Broker";
        const code =
          safeError?.code === "tenant_sandbox_capacity_exhausted" ||
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
      "Development environment exceeded the Tool Broker redirect limit",
    );
  }

  async #validatedOwnerRedirect(domainId: string, ownerBaseUrl: string): Promise<string> {
    const normalized = new URL(ownerBaseUrl).toString();
    const owner = await this.#database
      .selectFrom("tool_broker_instances")
      .select("owner_base_url")
      .where("sandbox_domain_id", "=", domainId)
      .where("owner_base_url", "=", normalized)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", new Date())
      .executeTakeFirst();
    if (owner === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Development environment Tool Broker redirect was stale",
      );
    }
    return owner.owner_base_url;
  }
}
