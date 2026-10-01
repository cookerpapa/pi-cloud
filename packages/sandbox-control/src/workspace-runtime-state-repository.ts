import { randomUUID } from "node:crypto";
import type {
  Database,
  DevelopmentEnvironmentState,
  SandboxControlWorkspaceRuntimeState,
  WorkspaceTerminalState,
} from "@pi-cloud/database";
import {
  createExecutionReference,
  parseExecutionReference,
  type ToolSandboxAssignment,
} from "@pi-cloud/protocol";
import type { DevelopmentEnvironmentProfileKey, SandboxPreviewTarget } from "@pi-cloud/protocol";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "@pi-cloud/protocol";
import type { WorkspaceUploadRequest } from "@pi-cloud/protocol";
import type { SandboxHandle } from "./sandbox-provider.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { databaseTime } from "@pi-cloud/database";

export type WorkspaceRuntimeReservation = {
  sandboxProfileKey: DevelopmentEnvironmentProfileKey;
  activationId: string;
  computeSessionId?: string;
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  executionContextSha256: string;
  environmentSha256: string;
};

function executionIdentity(assignment: ToolSandboxAssignment) {
  return parseExecutionReference(assignment.executionReference);
}

export type WorkspaceRuntimeReservationResult =
  | { status: "reserved" }
  | { status: "development_environment"; environmentId: string }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "capacity" };

export type OrphanedWorkspaceRuntime = Readonly<{
  runtimeCapsule?: string;
  activationId: string;
  assignment: ToolSandboxAssignment;
}>;

export type WorkspaceTerminalReservation = Readonly<{
  terminalId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
}>;

export type WorkspaceTerminalReservationResult =
  | {
      status: "reserved";
      executionReference: string;
      workspaceRuntimeId?: string;
    }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "capacity" };

export type OrphanedWorkspaceTerminal = WorkspaceTerminalReservation &
  Readonly<{ fencingToken: number; sharedRuntime?: boolean }>;

export type DevelopmentEnvironmentReservation = Readonly<{
  environmentId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  environmentVersionId: string;
  generation: number;
  profileKey: DevelopmentEnvironmentProfileKey;
}>;

export type DevelopmentEnvironmentReservationResult =
  | { status: "reserved" }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "capacity" };

export type DevelopmentEnvironmentOwnerResult =
  | {
      status: "owned";
      state: DevelopmentEnvironmentState;
      reservation: DevelopmentEnvironmentReservation;
      agentActive: boolean;
      terminalActive: boolean;
    }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "unavailable" };

export type RecoverableDevelopmentEnvironment = Readonly<{
  reservation: DevelopmentEnvironmentReservation;
  state: "running" | "paused" | "unknown";
  runtimeCapsule: string;
}>;

export type SandboxPreviewOwnerResult =
  | { status: "owned"; workspaceId?: string; runtimeId?: string }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "unavailable" };

export type RecoverableWorkspaceRuntime = Readonly<{
  sandboxProfileKey: DevelopmentEnvironmentProfileKey;
  activationId: string;
  computeSessionId?: string;
  runtimeCapsule: string;
}>;

export interface WorkspaceRuntimeStateRepository {
  claimRecoverableWorkspaceRuntimes(
    limit: number,
    excluded: readonly string[],
  ): Promise<readonly RecoverableWorkspaceRuntime[]>;
  authorizeWorkspaceUpload?(request: WorkspaceUploadRequest, byteLength: number): Promise<void>;
  start(): Promise<void>;
  checkHealth(): Promise<void>;
  assertLocalOwnership(): void;
  reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult>;
  returnDevelopmentEnvironment(
    environmentId: string,
    activationId: string,
    outcome: "running" | "unknown",
    detail?: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string },
  ): Promise<void>;
  reserveDevelopmentEnvironmentTerminal(environmentId: string): Promise<boolean>;
  releaseDevelopmentEnvironmentTerminal(environmentId: string): Promise<void>;
  reserveTerminal(input: WorkspaceTerminalReservation): Promise<WorkspaceTerminalReservationResult>;
  reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult>;
  developmentEnvironmentOwner(
    tenantId: string,
    userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult>;
  sandboxPreviewOwner(
    tenantId: string,
    userId: string,
    target: SandboxPreviewTarget,
  ): Promise<SandboxPreviewOwnerResult>;
  setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
    detail?: {
      handle?: SandboxHandle;
      failureCode?: string;
      runtimeCapsule?: string | null;
      agentActive?: boolean;
    },
  ): Promise<void>;
  claimRecoverableDevelopmentEnvironments(
    limit: number,
    excludeEnvironmentIds?: readonly string[],
  ): Promise<readonly RecoverableDevelopmentEnvironment[]>;
  claimOrphanedDevelopmentEnvironments(
    limit: number,
  ): Promise<readonly DevelopmentEnvironmentReservation[]>;
  setTerminalState(
    terminalId: string,
    state: WorkspaceTerminalState,
    detail?: { handle?: SandboxHandle; failureCode?: string },
  ): Promise<void>;
  claimOrphanedTerminals(limit: number): Promise<readonly OrphanedWorkspaceTerminal[]>;
  setWorkspaceRuntimeState(
    activationId: string,
    state: SandboxControlWorkspaceRuntimeState,
    detail?: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string },
  ): Promise<void>;
  claimOrphanedWorkspaceRuntimes(limit: number): Promise<readonly OrphanedWorkspaceRuntime[]>;
  claimUnboundWorkspaceRuntimes(
    limit: number,
    minimumUnboundAgeMs?: number,
  ): Promise<readonly OrphanedWorkspaceRuntime[]>;
  listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export class WorkspaceRuntimeStateRepositoryError extends Error {
  readonly code: "ownership_lost" | "state_conflict" | "unavailable";

  constructor(code: WorkspaceRuntimeStateRepositoryError["code"], message: string) {
    super(message);
    this.name = "WorkspaceRuntimeStateRepositoryError";
    this.code = code;
  }
}

export type PostgresWorkspaceRuntimeStateRepositoryOptions = {
  database: Kysely<Database>;
  sandboxDomainId: string;
  instanceId: string;
  ownerBaseUrl: string;
  leaseMs?: number;
  heartbeatMs?: number;
  clock?: () => Date;
  monotonicNow?: () => number;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Sandbox control state clock returned an invalid date");
  }
  return value;
}

function timestampValue(value: unknown, name: string): number {
  const timestamp = value instanceof Date ? value.valueOf() : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} was not a valid timestamp`);
  return timestamp;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function failureCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "tool_broker_failed";
}

function readyOwnerUrlConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505" && candidate.constraint === "tool_broker_ready_owner_url_unique"
  );
}

function developmentProfileKey(value: string): DevelopmentEnvironmentProfileKey {
  const profile = DEVELOPMENT_ENVIRONMENT_PROFILES.find((candidate) => candidate.key === value);
  if (profile === undefined) {
    throw new WorkspaceRuntimeStateRepositoryError(
      "state_conflict",
      "Development environment profile is invalid",
    );
  }
  return profile.key;
}

export class PostgresWorkspaceRuntimeStateRepository implements WorkspaceRuntimeStateRepository {
  readonly #database: Kysely<Database>;
  readonly #sandboxDomainId: string;
  readonly #instanceId: string;
  readonly #ownerBaseUrl: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #clock: () => Date;
  readonly #monotonicNow: () => number;
  #heartbeat: NodeJS.Timeout | undefined;
  #heartbeatTask: Promise<void> | undefined;
  #closed = false;
  #ownershipDeadline = 0;

  constructor(options: PostgresWorkspaceRuntimeStateRepositoryOptions) {
    this.#database = options.database;
    this.#sandboxDomainId = options.sandboxDomainId;
    this.#instanceId = options.instanceId;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#leaseMs = positiveInteger(options.leaseMs ?? 15_000, "leaseMs");
    this.#heartbeatMs = positiveInteger(options.heartbeatMs ?? 5_000, "heartbeatMs");
    if (this.#heartbeatMs * 2 >= this.#leaseMs) {
      throw new TypeError("Sandbox control heartbeat must leave lease failure margin");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async start(): Promise<void> {
    if (this.#heartbeat !== undefined || this.#closed) {
      throw new Error("Sandbox control state repository can only start once");
    }
    const startupDeadline = Date.now() + this.#leaseMs * 2;
    let leaseExpiresAt: Date | undefined;
    while (leaseExpiresAt === undefined) {
      const now = await databaseTime(this.#database);
      const currentOwner = await this.#database
        .selectFrom("sandbox_control_instances")
        .select("lease_expires_at")
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("owner_base_url", "=", this.#ownerBaseUrl)
        .where("state", "=", "ready")
        .executeTakeFirst();
      const currentOwnerLease =
        currentOwner === undefined
          ? undefined
          : timestampValue(currentOwner.lease_expires_at, "Sandbox control owner lease");
      if (currentOwnerLease !== undefined && currentOwnerLease > now.valueOf()) {
        if (Date.now() >= startupDeadline) {
          throw new WorkspaceRuntimeStateRepositoryError(
            "ownership_lost",
            "Sandbox control owner URL is still leased by another instance",
          );
        }
        await delay(
          Math.min(this.#heartbeatMs, Math.max(25, currentOwnerLease - now.valueOf() + 10)),
        );
        continue;
      }
      try {
        const issued = await this.#database.transaction().execute(async (transaction) => {
          await this.#markExpiredOwnersLost(transaction, now);
          return transaction
            .insertInto("sandbox_control_instances")
            .values({
              instance_id: this.#instanceId,
              sandbox_domain_id: this.#sandboxDomainId,
              owner_base_url: this.#ownerBaseUrl,
              state: "ready",
              lease_expires_at: sql<Date>`clock_timestamp() + ${this.#leaseMs} * interval '1 millisecond'`,
              last_heartbeat_at: sql<Date>`clock_timestamp()`,
              updated_at: now,
            })
            .returning("lease_expires_at")
            .executeTakeFirstOrThrow();
        });
        leaseExpiresAt = issued.lease_expires_at;
      } catch (error: unknown) {
        if (!readyOwnerUrlConflict(error) || Date.now() >= startupDeadline) throw error;
        const existing = await this.#database
          .selectFrom("sandbox_control_instances")
          .select("lease_expires_at")
          .where("sandbox_domain_id", "=", this.#sandboxDomainId)
          .where("owner_base_url", "=", this.#ownerBaseUrl)
          .where("state", "=", "ready")
          .executeTakeFirst();
        const waitMs = Math.min(
          this.#heartbeatMs,
          Math.max(
            25,
            (existing === undefined
              ? now.valueOf()
              : timestampValue(existing.lease_expires_at, "Sandbox control owner lease")) -
              now.valueOf() +
              10,
          ),
        );
        await delay(waitMs);
      }
    }
    await this.checkHealth();
    this.#heartbeat = setInterval(() => {
      if (this.#closed || this.#heartbeatTask) return;
      this.#heartbeatTask = this.#renew()
        .catch(() => undefined)
        .finally(() => {
          this.#heartbeatTask = undefined;
        });
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  async checkHealth(): Promise<void> {
    const requestedAt = this.#monotonicNow();
    const row = await this.#database
      .selectFrom("sandbox_control_instances")
      .select(
        sql<string>`extract(epoch from (lease_expires_at-clock_timestamp()))*1000`.as(
          "remaining_ms",
        ),
      )
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (row === undefined) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox control database ownership lease is not current",
      );
    }
    this.#ownershipDeadline = requestedAt + Number(row.remaining_ms);
  }

  assertLocalOwnership(): void {
    if (this.#closed || this.#monotonicNow() >= this.#ownershipDeadline) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox control locally confirmed ownership lease expired",
      );
    }
  }

  async reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult> {
    const now = validDate(this.#clock);
    const execution = executionIdentity(input.assignment);
    return this.#database.transaction().execute(async (transaction) => {
      const workspace = await transaction
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("workspaces.tenant_id", "=", input.assignment.tenantId)
        .where("workspaces.id", "=", input.assignment.workspaceId)
        .where("workspaces.deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (workspace?.sandbox_domain_id !== this.#sandboxDomainId) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace is not assigned to this Sandbox Domain",
        );
      }
      await this.#assertCurrentOwner(transaction);
      const liveTerminal =
        input.computeSessionId !== undefined
          ? undefined
          : await transaction
              .selectFrom("workspace_terminal_sessions")
              .select(["owner_instance_id", "owner_base_url"])
              .where("tenant_id", "=", input.assignment.tenantId)
              .where("workspace_id", "=", input.assignment.workspaceId)
              .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
              .executeTakeFirst();
      if (liveTerminal !== undefined && liveTerminal.owner_instance_id !== this.#instanceId) {
        return { status: "redirect", ownerBaseUrl: liveTerminal.owner_base_url };
      }
      const liveDevelopmentEnvironment =
        input.computeSessionId !== undefined
          ? undefined
          : await transaction
              .selectFrom("development_environments")
              .select([
                "id",
                "owner_instance_id",
                "owner_base_url",
                "state",
                "agent_activation_id",
                "terminal_active",
              ])
              .where("tenant_id", "=", input.assignment.tenantId)
              .where("workspace_id", "=", input.assignment.workspaceId)
              .where("state", "in", [
                "requested",
                "provisioning",
                "running",
                "paused",
                "releasing",
                "unknown",
              ])
              .executeTakeFirst();
      let borrowedDevelopmentEnvironmentId: string | undefined;
      let claimDevelopmentEnvironment = false;
      if (liveDevelopmentEnvironment !== undefined) {
        if (
          liveDevelopmentEnvironment.owner_instance_id !== this.#instanceId &&
          liveDevelopmentEnvironment.owner_base_url !== null
        ) {
          return { status: "redirect", ownerBaseUrl: liveDevelopmentEnvironment.owner_base_url };
        }
        if (
          liveDevelopmentEnvironment.owner_instance_id !== this.#instanceId ||
          liveDevelopmentEnvironment.state !== "running" ||
          liveDevelopmentEnvironment.id !== input.activationId ||
          (liveDevelopmentEnvironment.agent_activation_id !== null &&
            liveDevelopmentEnvironment.agent_activation_id !== liveDevelopmentEnvironment.id)
        ) {
          return { status: "busy" };
        }
        borrowedDevelopmentEnvironmentId = liveDevelopmentEnvironment.id;
        claimDevelopmentEnvironment = liveDevelopmentEnvironment.agent_activation_id === null;
      }
      const authority = await transaction
        .selectFrom("active_execution_scopes")
        .select(
          sql<
            string | null
          >`(select compute_session_id from runs where id=${input.assignment.runId}::uuid)`.as(
            "compute_session_id",
          ),
        )
        .select([
          "tenant_id",
          "project_id",
          "workspace_id",
          "session_id",
          "run_id",
          "turn_id",
          "sandbox_id",
        ])
        .where("lease_id", "=", execution.leaseId)
        .where("accepting_effects", "=", true)
        .where("run_id", "=", execution.runId)
        .where("fencing_token", "=", String(execution.fencingToken))
        .where("valid_until", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (
        authority === undefined ||
        authority.tenant_id !== input.assignment.tenantId ||
        authority.project_id !== input.assignment.projectId ||
        authority.workspace_id !== input.assignment.workspaceId ||
        authority.session_id !== input.assignment.sessionId ||
        authority.run_id !== input.assignment.runId ||
        authority.turn_id !== input.assignment.turnId ||
        authority.sandbox_id !== input.assignment.sandboxId ||
        authority.compute_session_id !== (input.computeSessionId ?? null)
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Tool binding reserve used a stale ExecutionReference",
        );
      }
      if (borrowedDevelopmentEnvironmentId !== undefined) {
        if (claimDevelopmentEnvironment) {
          await transaction
            .updateTable("development_environments")
            .set({ agent_activation_id: input.activationId, updated_at: now })
            .where("id", "=", borrowedDevelopmentEnvironmentId)
            .where("owner_instance_id", "=", this.#instanceId)
            .where("state", "=", "running")
            .executeTakeFirstOrThrow();
        }
        return {
          status: "development_environment",
          environmentId: borrowedDevelopmentEnvironmentId,
        };
      }
      const existing = await transaction
        .selectFrom("workspace_runtimes")
        .selectAll()
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where(
          sql<boolean>`compute_session_id is not distinct from ${input.computeSessionId ?? null}::uuid`,
        )
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.owner_instance_id !== this.#instanceId) {
          return { status: "redirect", ownerBaseUrl: existing.owner_base_url };
        }
        if (
          existing.workspace_runtime_id !== input.activationId ||
          existing.environment_sha256 !== input.environmentSha256 ||
          !["reserved", "materializing", "active", "warm"].includes(existing.state)
        ) {
          return { status: "busy" };
        }
        await transaction
          .updateTable("workspace_runtimes")
          .set({
            state: existing.state === "warm" ? "reserved" : existing.state,
            failure_code: null,
            updated_at: now,
          })
          .where("workspace_runtime_id", "=", input.activationId)
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "=", existing.state)
          .executeTakeFirstOrThrow();
        return { status: "reserved" };
      }
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Sandbox Domain is not active",
        );
      }
      if (
        liveTerminal === undefined &&
        (await this.#domainReservedSandboxes(transaction)) >= domain.maximum_active_sandboxes
      )
        return { status: "capacity" };
      const activationValues = {
        workspace_runtime_id: input.activationId,
        sandbox_profile_key: input.sandboxProfileKey,
        compute_session_id: input.computeSessionId ?? null,
        sandbox_domain_id: this.#sandboxDomainId,
        owner_instance_id: this.#instanceId,
        owner_base_url: this.#ownerBaseUrl,
        tenant_id: input.assignment.tenantId,
        project_id: input.assignment.projectId,
        workspace_id: input.assignment.workspaceId,
        supervisor_id: input.assignment.supervisorId,
        boot_id: input.assignment.bootId,
        sandbox_id: input.assignment.sandboxId,
        run_id: input.assignment.runId,
        session_id: input.assignment.sessionId,
        turn_id: input.assignment.turnId,
        lease_id: execution.leaseId,
        fencing_token: execution.fencingToken,
        turn_context_sha256: input.turnContextSha256,
        execution_context_sha256: input.executionContextSha256,
        environment_sha256: input.environmentSha256,
        runtime_id: null,
        runtime_name: null,
        state: "reserved",
        failure_code: null,
        updated_at: now,
      } as const;
      const retiredActivation = await transaction
        .selectFrom("workspace_runtimes")
        .select(["tenant_id", "project_id", "workspace_id", "state"])
        .where("workspace_runtime_id", "=", input.activationId)
        .forUpdate()
        .executeTakeFirst();
      if (retiredActivation !== undefined)
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Physical runtime identity was already used",
        );
      await transaction
        .insertInto("workspace_runtimes")
        .values(activationValues)
        .executeTakeFirstOrThrow();
      return { status: "reserved" };
    });
  }

  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    const now = validDate(this.#clock);
    const leaseExpiresAt = new Date(now.valueOf() + this.#leaseMs);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["sandbox_domain_id", "project_id", "workspace_kind"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.workspaceId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (
        workspace?.sandbox_domain_id !== this.#sandboxDomainId ||
        workspace.project_id !== input.projectId ||
        workspace.workspace_kind !== "user"
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal identity did not match this Sandbox Domain",
        );
      }
      const session = await transaction
        .selectFrom("sessions as s")
        .innerJoin("pi_sessions as p", (join) =>
          join.onRef("p.tenant_id", "=", "s.tenant_id").onRef("p.id", "=", "s.pi_session_id"),
        )
        .select(["s.id", "p.lease_epoch"])
        .where("s.tenant_id", "=", input.tenantId)
        .where("s.id", "=", input.sessionId)
        .where("s.workspace_id", "=", input.workspaceId)
        .where("s.pruned_at", "is", null)
        .forUpdate("s")
        .executeTakeFirst();
      if (session === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal Session was unavailable",
        );
      }
      const activation = await transaction
        .selectFrom("workspace_runtimes")
        .select([
          "workspace_runtime_id",
          "owner_instance_id",
          "owner_base_url",
          "state",
          "tenant_id",
          "project_id",
          "workspace_id",
          "supervisor_id",
          "boot_id",
          "sandbox_id",
          "run_id",
          "session_id",
          "turn_id",
          "lease_id",
          "fencing_token",
        ])
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("compute_session_id", "is", null)
        .where("state", "in", ["reserved", "materializing", "active", "warm"])
        .executeTakeFirst();
      const developmentEnvironment = await transaction
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", [
          "requested",
          "provisioning",
          "running",
          "paused",
          "releasing",
          "unknown",
        ])
        .executeTakeFirst();
      if (developmentEnvironment !== undefined) return { status: "busy" };
      if (
        activation?.owner_instance_id !== undefined &&
        activation.owner_instance_id !== this.#instanceId
      ) {
        return { status: "redirect", ownerBaseUrl: activation.owner_base_url };
      }
      const terminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select("terminal_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (terminal !== undefined) return { status: "busy" };
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal Sandbox Domain is unavailable",
        );
      }
      const domainReserved = await this.#domainReservedSandboxes(transaction);
      const existingWorkspaceRuntime = activation === undefined ? 0 : 1;
      if (domainReserved - existingWorkspaceRuntime >= domain.maximum_active_sandboxes) {
        return { status: "capacity" };
      }
      const currentFence = Math.max(
        Number(session.lease_epoch),
        activation === undefined ? 0 : Number(activation.fencing_token),
      );
      const generation = currentFence + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal fencing token is exhausted",
        );
      }
      await transaction
        .insertInto("workspace_terminal_sessions")
        .values({
          terminal_id: input.terminalId,
          sandbox_domain_id: this.#sandboxDomainId,
          owner_instance_id: this.#instanceId,
          owner_base_url: this.#ownerBaseUrl,
          tenant_id: input.tenantId,
          user_id: input.userId,
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          session_id: input.sessionId,
          fencing_token: generation,
          runtime_id: null,
          runtime_name: null,
          state: "reserved",
          lease_expires_at: leaseExpiresAt,
          last_heartbeat_at: now,
          failure_code: null,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      const executionReference = createExecutionReference(
        input.terminalId,
        activation?.run_id ?? input.terminalId,
        generation,
      );
      return {
        status: "reserved",
        executionReference,
        ...(activation === undefined
          ? {}
          : { workspaceRuntimeId: activation.workspace_runtime_id }),
      };
    });
  }

  async reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const environment = await transaction
        .selectFrom("development_environments")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.environmentId)
        .where("owner_user_id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        environment === undefined ||
        environment.project_id !== input.projectId ||
        environment.workspace_id !== input.workspaceId ||
        environment.sandbox_domain_id !== this.#sandboxDomainId ||
        environment.profile_key !== input.profileKey
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Development environment identity did not match this Sandbox Domain",
        );
      }
      if (
        environment.owner_instance_id !== null &&
        environment.owner_instance_id !== this.#instanceId &&
        ["provisioning", "running", "paused", "releasing"].includes(environment.state)
      ) {
        return { status: "redirect", ownerBaseUrl: environment.owner_base_url! };
      }
      if (environment.state !== "requested" && environment.state !== "failed") {
        return { status: "busy" };
      }
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["project_id", "sandbox_domain_id", "workspace_kind", "deleted_at"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        workspace === undefined ||
        workspace.deleted_at !== null ||
        workspace.workspace_kind !== "development_environment" ||
        workspace.project_id !== input.projectId ||
        workspace.sandbox_domain_id !== this.#sandboxDomainId
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Development environment Workspace is unavailable",
        );
      }
      const activeActivation = await transaction
        .selectFrom("workspace_runtimes")
        .select("workspace_runtime_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("compute_session_id", "is", null)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirst();
      const activeTerminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select("terminal_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (activeActivation !== undefined || activeTerminal !== undefined) {
        return { status: "busy" };
      }
      const domain = await transaction
        .selectFrom("sandbox_domains")
        .select("maximum_active_sandboxes")
        .where("id", "=", this.#sandboxDomainId)
        .where("state", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (domain === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Development environment Sandbox Domain is unavailable",
        );
      }
      const domainReserved = await this.#domainReservedSandboxes(transaction);
      if (domainReserved >= domain.maximum_active_sandboxes) return { status: "capacity" };
      await transaction
        .updateTable("development_environments")
        .set({
          environment_version_id: input.environmentVersionId,
          owner_instance_id: this.#instanceId,
          owner_base_url: this.#ownerBaseUrl,
          generation: input.generation,
          state: "provisioning",
          failure_code: null,
          released_at: null,
          updated_at: now,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.environmentId)
        .where("state", "=", environment.state)
        .executeTakeFirstOrThrow();
      return { status: "reserved" };
    });
  }

  async developmentEnvironmentOwner(
    tenantId: string,
    userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult> {
    this.assertLocalOwnership();
    const row = await this.#database
      .selectFrom("development_environments")
      .select([
        "id",
        "tenant_id",
        "owner_user_id",
        "project_id",
        "workspace_id",
        "environment_version_id",
        "generation",
        "profile_key",
        "owner_instance_id",
        "owner_base_url",
        "state",
        "agent_activation_id",
        "terminal_active",
      ])
      .where("tenant_id", "=", tenantId)
      .where("owner_user_id", "=", userId)
      .where("id", "=", environmentId)
      .executeTakeFirst();
    if (row === undefined || ["requested", "released", "failed"].includes(row.state)) {
      return { status: "unavailable" };
    }
    if (row.owner_instance_id !== this.#instanceId) {
      const owner =
        row.owner_instance_id === null
          ? undefined
          : await this.#database
              .selectFrom("sandbox_control_instances")
              .select("owner_base_url")
              .where("instance_id", "=", row.owner_instance_id)
              .where("state", "=", "ready")
              .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
              .executeTakeFirst();
      return owner === undefined
        ? { status: "unavailable" }
        : { status: "redirect", ownerBaseUrl: owner.owner_base_url };
    }
    if (row.environment_version_id === null) return { status: "unavailable" };
    return {
      status: "owned",
      state: row.state,
      reservation: {
        environmentId: row.id,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        environmentVersionId: row.environment_version_id,
        generation: Number(row.generation),
        profileKey: developmentProfileKey(row.profile_key),
      },
      agentActive: row.agent_activation_id !== null,
      terminalActive: row.terminal_active,
    };
  }

  async sandboxPreviewOwner(
    tenantId: string,
    userId: string,
    target: SandboxPreviewTarget,
  ): Promise<SandboxPreviewOwnerResult> {
    if (target.kind === "development_environment") {
      const owner = await this.developmentEnvironmentOwner(tenantId, userId, target.environmentId);
      if (owner.status !== "owned") return owner;
      return owner.state === "running" ? { status: "owned" } : { status: "unavailable" };
    }
    const activation = await this.#database
      .selectFrom("sandbox_http_services as service")
      .innerJoin("workspace_runtimes as activation", (join) =>
        join
          .onRef("activation.tenant_id", "=", "service.tenant_id")
          .onRef("activation.workspace_id", "=", "service.workspace_id")
          .onRef("activation.runtime_id", "=", "service.runtime_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "service.tenant_id")
          .onRef("session_row.id", "=", "service.session_id"),
      )
      .select([
        "activation.owner_instance_id",
        "activation.owner_base_url",
        "activation.workspace_id",
        "activation.runtime_id",
      ])
      .where("service.tenant_id", "=", tenantId)
      .where("service.target_kind", "=", "conversation")
      .where("service.target_id", "=", target.sessionId)
      .where("service.state", "=", "active")
      .where("activation.state", "in", ["materializing", "active", "warm", "cleaning"])
      .where("session_row.pruned_at", "is", null)
      .orderBy("service.last_seen_at", "desc")
      .executeTakeFirst();
    if (activation === undefined) return { status: "unavailable" };
    return activation.owner_instance_id === this.#instanceId
      ? {
          status: "owned",
          workspaceId: activation.workspace_id,
          ...(activation.runtime_id === null ? {} : { runtimeId: activation.runtime_id }),
        }
      : { status: "redirect", ownerBaseUrl: activation.owner_base_url };
  }

  async setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
    detail: {
      handle?: SandboxHandle;
      failureCode?: string;
      runtimeCapsule?: string | null;
      agentActive?: boolean;
    } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      return transaction
        .updateTable("development_environments")
        .set({
          state,
          ...(detail.agentActive === undefined
            ? {}
            : { agent_activation_id: detail.agentActive ? environmentId : null }),
          ...(state === "running" || state === "unknown" ? {} : { terminal_active: false }),
          ...(state === "released" ? { owner_instance_id: null, owner_base_url: null } : {}),
          ...(state === "released" || state === "failed"
            ? { runtime_id: null, runtime_name: null }
            : detail.handle === undefined
              ? {}
              : {
                  runtime_id: detail.handle?.runtimeId ?? null,
                  runtime_name: detail.handle?.runtimeName ?? null,
                }),
          ...(state === "released"
            ? { runtime_capsule: null }
            : detail.runtimeCapsule === undefined
              ? {}
              : { runtime_capsule: detail.runtimeCapsule }),
          failure_code: failureCode(detail.failureCode),
          released_at: state === "released" ? now : null,
          updated_at: now,
        })
        .where("id", "=", environmentId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Development environment ownership is no longer current",
      );
    }
  }

  async returnDevelopmentEnvironment(
    environmentId: string,
    activationId: string,
    outcome: "running" | "unknown",
    detail: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const returned = await transaction
        .updateTable("development_environments")
        .set({
          agent_activation_id: null,
          state: outcome,
          ...(detail.handle === undefined
            ? {}
            : {
                runtime_id: detail.handle.runtimeId,
                runtime_name: detail.handle.runtimeName,
              }),
          ...(detail.runtimeCapsule === undefined
            ? {}
            : { runtime_capsule: detail.runtimeCapsule }),
          failure_code: outcome === "unknown" ? failureCode(detail.failureCode) : null,
          updated_at: now,
        })
        .where("id", "=", environmentId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("agent_activation_id", "=", activationId)
        .executeTakeFirst();
      if (returned.numUpdatedRows !== 1n) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Development environment Agent binding is no longer current",
        );
      }
    });
  }

  async reserveDevelopmentEnvironmentTerminal(environmentId: string): Promise<boolean> {
    const now = validDate(this.#clock);
    const reserved = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      return transaction
        .updateTable("development_environments")
        .set({ terminal_active: true, updated_at: now })
        .where("id", "=", environmentId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .where("terminal_active", "=", false)
        .executeTakeFirst();
    });
    return reserved.numUpdatedRows === 1n;
  }

  async releaseDevelopmentEnvironmentTerminal(environmentId: string): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database
      .updateTable("development_environments")
      .set({ terminal_active: false, updated_at: now })
      .where("id", "=", environmentId)
      .where("owner_instance_id", "=", this.#instanceId)
      .executeTakeFirst();
  }

  async claimOrphanedDevelopmentEnvironments(
    limit: number,
  ): Promise<readonly DevelopmentEnvironmentReservation[]> {
    const boundedLimit = positiveInteger(limit, "development environment orphan limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const rows = await transaction
        .selectFrom("development_environments")
        .select([
          "id",
          "tenant_id",
          "owner_user_id",
          "project_id",
          "workspace_id",
          "environment_version_id",
          "generation",
          "profile_key",
        ])
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .where("runtime_capsule", "is", null)
        .where(sql<boolean>`failure_code is distinct from 'persistent_machine_recovery_required'`)
        .where("environment_version_id", "is not", null)
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("development_environments")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "unknown",
            failure_code: "persistent_machine_recovery_required",
            updated_at: now,
          })
          .where("id", "=", row.id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        environmentId: row.id,
        tenantId: row.tenant_id,
        userId: row.owner_user_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        environmentVersionId: row.environment_version_id!,
        generation: Number(row.generation),
        profileKey: developmentProfileKey(row.profile_key),
      }));
    });
  }

  async claimRecoverableWorkspaceRuntimes(
    limit: number,
    excluded: readonly string[],
  ): Promise<readonly RecoverableWorkspaceRuntime[]> {
    const bounded = positiveInteger(limit, "Workspace recovery limit");
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      let query = transaction
        .selectFrom("workspace_runtimes as runtime")
        .leftJoin(
          "sandbox_control_instances as owner",
          "owner.instance_id",
          "runtime.owner_instance_id",
        )
        .select([
          "runtime.workspace_runtime_id",
          "runtime.compute_session_id",
          "runtime.runtime_capsule",
          "runtime.sandbox_profile_key",
        ])
        .where("runtime.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("runtime.runtime_capsule", "is not", null)
        .where((eb) =>
          eb.or([
            eb("runtime.failure_code", "is", null),
            eb("runtime.failure_code", "not in", [
              "runtime_recovery_unconfirmed",
              "execution_stop_unconfirmed",
            ]),
          ]),
        )
        .where("runtime.state", "in", ["active", "warm", "unknown"])
        .where((eb) =>
          eb.or([
            eb("runtime.owner_instance_id", "=", this.#instanceId),
            eb("owner.instance_id", "is", null),
            eb("owner.state", "!=", "ready"),
            eb("owner.lease_expires_at", "<=", sql<Date>`clock_timestamp()`),
          ]),
        );
      if (excluded.length) query = query.where("runtime.workspace_runtime_id", "not in", excluded);
      const rows = await query
        .orderBy("runtime.updated_at", "asc")
        .limit(bounded)
        .forUpdate("runtime")
        .skipLocked()
        .execute();
      if (rows.length)
        await transaction
          .updateTable("workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            updated_at: sql<Date>`clock_timestamp()`,
          })
          .where(
            "workspace_runtime_id",
            "in",
            rows.map((row) => row.workspace_runtime_id),
          )
          .execute();
      return rows.map((row) => ({
        activationId: row.workspace_runtime_id,
        runtimeCapsule: row.runtime_capsule!,
        sandboxProfileKey: row.sandbox_profile_key,
        ...(row.compute_session_id ? { computeSessionId: row.compute_session_id } : {}),
      }));
    });
  }

  async claimRecoverableDevelopmentEnvironments(
    limit: number,
    excludeEnvironmentIds: readonly string[] = [],
  ): Promise<readonly RecoverableDevelopmentEnvironment[]> {
    const boundedLimit = positiveInteger(limit, "development environment recovery limit");
    const excluded = [...new Set(excludeEnvironmentIds)];
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const candidates = transaction
        .selectFrom("development_environments as environment")
        .leftJoin("sandbox_control_instances as owner", (join) =>
          join.onRef("owner.instance_id", "=", "environment.owner_instance_id"),
        )
        .select([
          "environment.id",
          "environment.tenant_id",
          "environment.owner_user_id",
          "environment.project_id",
          "environment.workspace_id",
          "environment.environment_version_id",
          "environment.generation",
          "environment.profile_key",
          "environment.state",
          "environment.runtime_capsule",
        ])
        .where("environment.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("environment.state", "in", ["running", "paused", "unknown"])
        .where("environment.runtime_capsule", "is not", null)
        .where("environment.environment_version_id", "is not", null)
        .where((expression) =>
          expression.or([
            expression("environment.owner_instance_id", "=", this.#instanceId),
            expression("owner.instance_id", "is", null),
            expression("owner.state", "!=", "ready"),
            expression("owner.lease_expires_at", "<=", sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy("environment.updated_at", "asc");
      const rows = await (
        excluded.length === 0 ? candidates : candidates.where("environment.id", "not in", excluded)
      )
        .limit(boundedLimit)
        .forUpdate("environment")
        .skipLocked()
        .execute();
      const recovered: RecoverableDevelopmentEnvironment[] = [];
      for (const row of rows) {
        const updated = await transaction
          .updateTable("development_environments")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            failure_code: null,
            terminal_active: false,
            updated_at: now,
          })
          .where("id", "=", row.id)
          .where("runtime_capsule", "=", row.runtime_capsule)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) continue;
        recovered.push({
          reservation: {
            environmentId: row.id,
            tenantId: row.tenant_id,
            userId: row.owner_user_id,
            projectId: row.project_id,
            workspaceId: row.workspace_id,
            environmentVersionId: row.environment_version_id!,
            generation: Number(row.generation),
            profileKey: developmentProfileKey(row.profile_key),
          },
          state: row.state as "running" | "paused" | "unknown",
          runtimeCapsule: row.runtime_capsule!,
        });
      }
      return recovered;
    });
  }

  async setTerminalState(
    terminalId: string,
    state: WorkspaceTerminalState,
    detail: { handle?: SandboxHandle; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      return transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          lease_expires_at: sql<Date>`clock_timestamp() + ${this.#leaseMs} * interval '1 millisecond'`,
          last_heartbeat_at: now,
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("terminal_id", "=", terminalId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Workspace terminal ownership is no longer current",
      );
    }
  }

  async claimOrphanedTerminals(limit: number): Promise<readonly OrphanedWorkspaceTerminal[]> {
    const boundedLimit = positiveInteger(limit, "terminal orphan cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const rows = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select([
          "terminal_id",
          "tenant_id",
          "user_id",
          "project_id",
          "workspace_id",
          "session_id",
          "fencing_token",
        ])
        .select(
          sql<boolean>`exists (select 1 from workspace_runtimes r where r.tenant_id=workspace_terminal_sessions.tenant_id
          and r.workspace_id=workspace_terminal_sessions.workspace_id and r.compute_session_id is null
          and r.state in ('reserved','materializing','active','warm','cleaning','unknown'))`.as(
            "shared_runtime",
          ),
        )
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("workspace_terminal_sessions")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            lease_expires_at: sql<Date>`clock_timestamp() + ${this.#leaseMs} * interval '1 millisecond'`,
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("terminal_id", "=", row.terminal_id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        terminalId: row.terminal_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
        projectId: row.project_id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        fencingToken: Number(row.fencing_token),
        sharedRuntime: row.shared_runtime,
      }));
    });
  }

  async setWorkspaceRuntimeState(
    activationId: string,
    state: SandboxControlWorkspaceRuntimeState,
    detail: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const result = await transaction
        .updateTable("workspace_runtimes")
        .set({
          state,
          ...(state === "released"
            ? { runtime_id: null, runtime_name: null, runtime_capsule: null }
            : {
                ...(detail.handle
                  ? { runtime_id: detail.handle.runtimeId, runtime_name: detail.handle.runtimeName }
                  : {}),
                ...(detail.runtimeCapsule ? { runtime_capsule: detail.runtimeCapsule } : {}),
              }),
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("workspace_runtime_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
      if (result.numUpdatedRows === 1n && state === "active" && detail.handle !== undefined) {
        const { assignment, environment, environmentValidation } = detail.handle;
        // Activation evidence is independent of file persistence. The conditional
        // update records it once per environment version, not on every Tool/Run.
        const validated = await transaction
          .updateTable("environment_versions")
          .set({ state: "validated", failure_code: null, validated_at: now, updated_at: now })
          .where("tenant_id", "=", assignment.tenantId)
          .where("project_id", "=", assignment.projectId)
          .where("id", "=", environment.environmentVersionId)
          .where("spec_sha256", "=", environmentValidation.specSha256)
          .where("recipe_sha256", "=", environmentValidation.recipeSha256)
          .where("image_revision", "=", environmentValidation.imageRevision)
          .where("state", "!=", "validated")
          .returning("id")
          .executeTakeFirst();
        if (validated !== undefined)
          await transaction
            .insertInto("environment_validations")
            .values({
              id: randomUUID(),
              tenant_id: assignment.tenantId,
              project_id: assignment.projectId,
              environment_version_id: validated.id,
              run_id: null,
              status: "validated",
              report: environmentValidation,
              failure_code: null,
              validated_at: now,
            })
            .executeTakeFirstOrThrow();
      }
      return result;
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Workspace runtime ownership is no longer current",
      );
    }
  }

  async authorizeWorkspaceUpload(
    request: WorkspaceUploadRequest,
    byteLength: number,
  ): Promise<void> {
    const directory =
      request.machine?.directory ??
      (request.rootPath ? `/workspace/${request.rootPath}` : "/workspace");
    const { rows } = await sql`select u.id from session_uploads u
      join sessions s on s.id=u.session_id and s.tenant_id=u.tenant_id
      join workspaces w on w.id=u.workspace_id and w.tenant_id=u.tenant_id
      join sandbox_control_instances b on b.instance_id=${this.#instanceId}::uuid
      where u.id=${request.uploadId}::uuid and u.claim_token=${request.claimToken}::uuid
        and u.tenant_id=${request.tenantId}::uuid and u.session_id=${request.sessionId}::uuid
        and u.workspace_id=${request.workspaceId}::uuid and u.name=${request.name}
        and u.sha256=${request.sha256} and u.byte_length=${byteLength}
        and u.state='uploading' and u.lease_expires_at>clock_timestamp()
        and u.working_directory=${directory} and s.working_directory=u.working_directory
        and s.workspace_id=u.workspace_id and s.pruned_at is null and w.deleted_at is null
        and w.sandbox_domain_id=${this.#sandboxDomainId}
        and b.state='ready' and b.lease_expires_at>clock_timestamp()
        and ((${request.machine?.environmentId ?? null}::uuid is null and s.execution_mode='elastic') or (
          s.execution_mode='development_environment' and
          s.development_environment_id=${request.machine?.environmentId ?? null}::uuid
          and u.actor_user_id=${request.machine?.userId ?? null}::uuid
        ))`.execute(this.#database);
    if (rows.length !== 1)
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Workspace upload grant is no longer current",
      );
  }

  async claimOrphanedWorkspaceRuntimes(
    limit: number,
  ): Promise<readonly OrphanedWorkspaceRuntime[]> {
    const boundedLimit = positiveInteger(limit, "orphan cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const rows = await transaction
        .selectFrom("workspace_runtimes")
        .select([
          "workspace_runtime_id",
          "runtime_capsule",
          "tenant_id",
          "project_id",
          "workspace_id",
          "supervisor_id",
          "boot_id",
          "sandbox_id",
          "run_id",
          "session_id",
          "turn_id",
          "lease_id",
          "fencing_token",
        ])
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["unknown", "cleaning"])
        .where("updated_at", "<=", new Date(now.valueOf() - 30_000))
        .where((eb) =>
          eb.or([
            eb("owner_instance_id", "=", this.#instanceId),
            sql<boolean>`not exists (select 1 from sandbox_control_instances owner where owner.instance_id=workspace_runtimes.owner_instance_id and owner.state='ready' and owner.lease_expires_at>clock_timestamp())`,
          ]),
        )
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            updated_at: now,
          })
          .where("workspace_runtime_id", "=", row.workspace_runtime_id)
          .where("state", "in", ["unknown", "cleaning"])
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        activationId: row.workspace_runtime_id,
        ...(row.runtime_capsule ? { runtimeCapsule: row.runtime_capsule } : {}),
        assignment: {
          tenantId: row.tenant_id,
          projectId: row.project_id,
          workspaceId: row.workspace_id,
          supervisorId: row.supervisor_id,
          bootId: row.boot_id,
          sandboxId: row.sandbox_id,
          runId: row.run_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          executionReference: createExecutionReference(
            row.lease_id,
            row.run_id,
            Number(row.fencing_token),
          ),
        },
      }));
    });
  }

  async claimUnboundWorkspaceRuntimes(
    limit: number,
    minimumUnboundAgeMs = Math.max(this.#leaseMs * 2, 30_000),
  ): Promise<readonly OrphanedWorkspaceRuntime[]> {
    const boundedLimit = positiveInteger(limit, "unbound Workspace runtime cleanup limit");
    if (
      !Number.isSafeInteger(minimumUnboundAgeMs) ||
      minimumUnboundAgeMs < 0 ||
      minimumUnboundAgeMs > 300_000
    ) {
      throw new TypeError("unbound Workspace runtime cleanup age is invalid");
    }
    const now = validDate(this.#clock);
    // Binding release and lease expiry are separate network events. Wait at
    // least two Broker lease windows before treating a runtime with no live
    // Workspace lease as orphaned.
    const orphanedBefore = new Date(now.valueOf() - minimumUnboundAgeMs);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const rows = await transaction
        .selectFrom("workspace_runtimes as activation")
        .select([
          "activation.workspace_runtime_id",
          "activation.runtime_capsule",
          "activation.tenant_id",
          "activation.project_id",
          "activation.workspace_id",
          "activation.supervisor_id",
          "activation.boot_id",
          "activation.sandbox_id",
          "activation.run_id",
          "activation.session_id",
          "activation.turn_id",
          "activation.lease_id",
          "activation.fencing_token",
        ])
        .where("activation.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("activation.state", "in", ["reserved", "materializing", "active", "warm"])
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where((eb) =>
          eb.or([
            // A retained conversation keeps between-Turn warm reuse. Once its
            // final reference disappears, no warm TTL or orphan grace is needed.
            sql<boolean>`not exists (
            select 1 from sessions s join workspaces w
              on w.tenant_id=s.tenant_id and w.id=s.workspace_id
            where s.tenant_id=activation.tenant_id and s.workspace_id=activation.workspace_id
              and s.execution_mode='elastic' and s.pruned_at is null and w.deleted_at is null
              and s.compute_session_id is not distinct from activation.compute_session_id
          )`,
            eb.and([
              eb("activation.state", "in", ["reserved", "materializing", "active"]),
              eb("activation.updated_at", "<", orphanedBefore),
            ]),
          ]),
        )
        .where(
          sql<boolean>`not exists (
            select 1
              from active_execution_scopes authority
              join runs task on task.id = authority.run_id
             where authority.tenant_id = ${sql.ref("activation.tenant_id")}
               and authority.project_id = ${sql.ref("activation.project_id")}
               and authority.workspace_id = ${sql.ref("activation.workspace_id")}
               and task.compute_session_id is not distinct from ${sql.ref("activation.compute_session_id")}
               and authority.valid_until > clock_timestamp()
          )`,
        )
        .orderBy("activation.updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate("activation")
        .skipLocked()
        .execute();
      const activationIds = rows.map((row) => row.workspace_runtime_id);
      if (activationIds.length > 0) {
        await transaction
          .updateTable("workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            failure_code: "workspace_runtime_unbound",
            updated_at: now,
          })
          .where("workspace_runtime_id", "in", activationIds)
          .execute();
      }
      return rows.map((row) => ({
        activationId: row.workspace_runtime_id,
        ...(row.runtime_capsule ? { runtimeCapsule: row.runtime_capsule } : {}),
        assignment: {
          tenantId: row.tenant_id,
          projectId: row.project_id,
          workspaceId: row.workspace_id,
          supervisorId: row.supervisor_id,
          bootId: row.boot_id,
          sandboxId: row.sandbox_id,
          runId: row.run_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          executionReference: createExecutionReference(
            row.lease_id,
            row.run_id,
            Number(row.fencing_token),
          ),
        },
      }));
    });
  }

  async listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction);
      const rows = await transaction
        .selectFrom("workspace_runtimes as activation")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "activation.tenant_id")
            .onRef("workspace.id", "=", "activation.workspace_id"),
        )
        .select("activation.workspace_runtime_id as activationId")
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where("activation.state", "=", "warm")
        .where("workspace.deleted_at", "is not", null)
        .execute();
      return rows.map((row) => row.activationId);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ownershipDeadline = 0;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    await this.#heartbeatTask;
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("workspace_runtimes")
        .set({ state: "unknown", failure_code: "tool_broker_stopped", updated_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "warm"])
        .execute();
      await transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state: "unknown",
          failure_code: "tool_broker_stopped",
          lease_expires_at: now,
          updated_at: now,
        })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
        .execute();
      await transaction
        .updateTable("development_environments")
        .set({
          state: "unknown",
          runtime_id: null,
          runtime_name: null,
          failure_code: "tool_broker_stopped",
          updated_at: now,
        })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing"])
        .where("runtime_capsule", "is", null)
        .execute();
      await transaction
        .updateTable("sandbox_control_instances")
        .set({ state: "stopped", lease_expires_at: now, updated_at: now })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .execute();
    });
  }

  async #renew(): Promise<void> {
    const requestedAt = this.#monotonicNow();
    const renewed = await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("sandbox_control_instances")
        .select("instance_id")
        .where("instance_id", "=", this.#instanceId)
        .forNoKeyUpdate()
        .execute();
      const now = await databaseTime(transaction);
      await this.#markExpiredOwnersLost(transaction, now);
      const owner = await transaction
        .updateTable("sandbox_control_instances")
        .set({
          last_heartbeat_at: sql<Date>`clock_timestamp()`,
          lease_expires_at: sql<Date>`clock_timestamp() + ${this.#leaseMs} * interval '1 millisecond'`,
          updated_at: now,
        })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .returning(["lease_expires_at", "last_heartbeat_at"])
        .executeTakeFirst();
      if (owner) {
        await transaction
          .updateTable("workspace_terminal_sessions")
          .set({
            lease_expires_at: owner.lease_expires_at,
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
          .execute();
      }
      return owner;
    });
    if (!renewed) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox control ownership heartbeat was fenced",
      );
    }
    this.#ownershipDeadline =
      requestedAt + renewed.lease_expires_at.valueOf() - renewed.last_heartbeat_at.valueOf();
  }

  async #assertCurrentOwner(transaction: Transaction<Database>): Promise<void> {
    const owner = await transaction
      .selectFrom("sandbox_control_instances")
      .select("instance_id")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (owner === undefined) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox control database ownership lease is not current",
      );
    }
  }

  async #domainReservedSandboxes(transaction: Transaction<Database>): Promise<number> {
    const result = await sql<{ count: string }>`select count(*) as count from (
      select workspace_runtime_id as id from workspace_runtimes
       where sandbox_domain_id=${this.#sandboxDomainId} and state in ('reserved','materializing','active','warm','cleaning','unknown')
      union
      select id from development_environments where sandbox_domain_id=${this.#sandboxDomainId}
        and state in ('provisioning','running','paused','releasing','unknown')
      union
      select t.terminal_id as id from workspace_terminal_sessions t where t.sandbox_domain_id=${this.#sandboxDomainId}
        and t.state in ('reserved','materializing','active','cleaning','unknown')
        and not exists(select 1 from workspace_runtimes r where r.tenant_id=t.tenant_id and r.workspace_id=t.workspace_id
          and r.compute_session_id is null and r.state in ('reserved','materializing','active','warm','cleaning','unknown'))
    ) physical_allocations`.execute(transaction);
    return Number(result.rows[0]!.count);
  }

  async #markExpiredOwnersLost(transaction: Transaction<Database>, now: Date): Promise<void> {
    const lostInstances = (
      await sql<{ instance_id: string }>`
      with candidates as materialized (
        select instance_id from sandbox_control_instances
        where sandbox_domain_id=${this.#sandboxDomainId} and state='ready'
          and lease_expires_at<=clock_timestamp()
        order by instance_id for update skip locked
      )
      update sandbox_control_instances i set state='lost',updated_at=clock_timestamp()
      from candidates c where i.instance_id=c.instance_id and i.state='ready'
        and i.lease_expires_at<=clock_timestamp() returning i.instance_id
    `.execute(transaction)
    ).rows;
    const lostIds = lostInstances.map((instance) => instance.instance_id);
    if (lostIds.length === 0) return;
    await transaction
      .updateTable("workspace_runtimes")
      .set({ state: "unknown", failure_code: "tool_broker_owner_lost", updated_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "warm"])
      .execute();
    await transaction
      .updateTable("workspace_terminal_sessions")
      .set({
        state: "unknown",
        failure_code: "tool_broker_owner_lost",
        lease_expires_at: now,
        updated_at: now,
      })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
      .execute();
    await transaction
      .updateTable("development_environments")
      .set({
        state: "unknown",
        failure_code: "tool_broker_owner_lost",
        updated_at: now,
      })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["provisioning", "running", "paused", "releasing"])
      .execute();
  }
}
