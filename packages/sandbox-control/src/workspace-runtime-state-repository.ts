import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Database,
  DevelopmentEnvironmentState,
  SandboxControlWorkspaceRuntimeState,
  WorkspaceTerminalState,
} from "@pi-cloud/database";
import {
  createExecutionReference,
  parseEnvironmentRuntimeSnapshot,
  type EnvironmentRuntimeSnapshot,
  parseExecutionReference,
  type ToolSandboxAssignment,
} from "@pi-cloud/protocol";
import type { DevelopmentEnvironmentProfileKey, SandboxPreviewTarget } from "@pi-cloud/protocol";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "@pi-cloud/protocol";
import type { WorkspaceUploadRequest } from "@pi-cloud/protocol";
import {
  SANDBOX_CREATION_WINDOW_MS,
  type SandboxHandle,
  type SandboxCreateSpec,
  type SandboxAllocationAuthorization,
} from "./sandbox-provider.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { databaseTime, environmentForImage } from "@pi-cloud/database";

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
  allocationId: string;
  intentRevision: number;
  desiredState: "running" | "paused" | "released";
  environmentId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  environmentVersionId: string;
  generation: number;
  profileKey: DevelopmentEnvironmentProfileKey;
  allocationClosed?: boolean;
  allocationAbsent?: boolean;
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
  state: DevelopmentEnvironmentState;
  allocationAbsent: boolean;
  environment?: EnvironmentRuntimeSnapshot;
  runtimeCapsule?: string;
  creation?: AllocationRecovery;
}>;

export type SandboxPreviewOwnerResult =
  | { status: "owned"; workspaceId?: string; runtimeId?: string }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "unavailable" };

export type RecoverableWorkspaceRuntime = Readonly<{
  runtimeId?: string;
  workspace: Pick<ToolSandboxAssignment, "tenantId" | "projectId" | "workspaceId">;
  sandboxProfileKey: DevelopmentEnvironmentProfileKey;
  activationId: string;
  computeSessionId?: string;
  runtimeCapsule?: string;
  creation?: AllocationRecovery;
}>;

export type AllocationRecovery = Readonly<{
  spec: SandboxCreateSpec;
  authorization: SandboxAllocationAuthorization;
}>;
export type AllocationClosure =
  | { status: "never_issued" }
  | { status: "legacy" }
  | { status: "authorized"; authorization: SandboxAllocationAuthorization };
export type AllocationKind = "workspace" | "development_environment" | "terminal";

function allocationRecovery(
  id: string,
  spec: Record<string, unknown> | null,
  deadline: Date | null,
): AllocationRecovery | undefined {
  if (spec === null || deadline === null) return undefined;
  if (
    spec.activationId !== id ||
    !spec.assignment ||
    !spec.environment ||
    !spec.policy ||
    !spec.workspaceSeed
  )
    throw new Error("Stored allocation identity is invalid");
  return {
    spec: spec as SandboxCreateSpec,
    authorization: { createBefore: new Date(deadline).valueOf() },
  };
}

export interface WorkspaceRuntimeStateRepository {
  beginCreation(
    spec: SandboxCreateSpec,
    kind?: AllocationKind,
  ): Promise<SandboxAllocationAuthorization>;
  closeAllocation(id: string, kind: AllocationKind): Promise<AllocationClosure>;
  claimRecoverableWorkspaceRuntimes(
    limit: number,
    excluded: readonly string[],
  ): Promise<readonly RecoverableWorkspaceRuntime[]>;
  authorizeWorkspaceUpload?(request: WorkspaceUploadRequest, byteLength: number): Promise<void>;
  start(): Promise<void>;
  reconcileOwnership(): Promise<void>;
  checkHealth(): Promise<void>;
  assertLocalOwnership(): void;
  reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult>;
  returnDevelopmentEnvironment(
    environmentId: string,
    activationId: string,
    detail?: { handle?: SandboxHandle; runtimeCapsule?: string },
  ): Promise<void>;
  reserveDevelopmentEnvironmentTerminal(
    environmentId: string,
    allocationId: string,
  ): Promise<boolean>;
  releaseDevelopmentEnvironmentTerminal(environmentId: string, allocationId: string): Promise<void>;
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
    identity: Pick<
      DevelopmentEnvironmentReservation,
      "environmentId" | "allocationId" | "intentRevision"
    >,
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
  confirmDevelopmentEnvironmentAbsent(identity: DevelopmentEnvironmentReservation): Promise<void>;
  prepareDevelopmentEnvironmentImage(
    identity: DevelopmentEnvironmentReservation,
    imageRevision: string,
  ): Promise<EnvironmentRuntimeSnapshot>;
  replaceDevelopmentEnvironmentAllocation(
    identity: DevelopmentEnvironmentReservation,
    spec: SandboxCreateSpec,
  ): Promise<DevelopmentEnvironmentReservation>;
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
  claimWarmRuntimeRetirement(activationId: string): Promise<boolean>;
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

  constructor(
    code: WorkspaceRuntimeStateRepositoryError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
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
  #reconciliation: Promise<void> | undefined;
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
        const issued = await this.#transaction(async (transaction) => {
          await this.#markExpiredOwnersLost(transaction);
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
    await this.reconcileOwnership();
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

  async beginCreation(
    spec: SandboxCreateSpec,
    kind: AllocationKind = spec.lifetime === "development_environment"
      ? "development_environment"
      : "workspace",
  ): Promise<SandboxAllocationAuthorization> {
    const encoded = JSON.stringify(spec);
    if (Buffer.byteLength(encoded) > 256 * 1024)
      throw new WorkspaceRuntimeStateRepositoryError(
        "state_conflict",
        "Allocation specification exceeds its transport budget",
      );
    const table = sql.table(
      kind === "terminal"
        ? "workspace_terminal_sessions"
        : kind === "development_environment"
          ? "development_environments"
          : "workspace_runtimes",
    );
    const key = sql.ref(
      kind === "terminal"
        ? "terminal_id"
        : kind === "development_environment"
          ? "allocation_id"
          : "workspace_runtime_id",
    );
    return this.#ownedTransaction(async (tx) => {
      const { rows } = await sql<{
        creation_spec: Record<string, unknown>;
        creation_not_after: Date;
      }>`
        update ${table} set creation_spec=coalesce(creation_spec,${encoded}::jsonb),
          creation_not_after=coalesce(creation_not_after,clock_timestamp()+${SANDBOX_CREATION_WINDOW_MS}*interval '1 millisecond'),
          updated_at=clock_timestamp()
        where ${key}=${spec.activationId}::uuid and tenant_id=${spec.assignment.tenantId}::uuid
          and workspace_id=${spec.assignment.workspaceId}::uuid and owner_instance_id=${this.#instanceId}::uuid
          and sandbox_domain_id=${this.#sandboxDomainId} and allocation_protocol=1 and not allocation_closed
          and state in ('reserved','materializing','provisioning','unknown','reconciling')
          and exists(select 1 from workspaces w where w.id=${spec.assignment.workspaceId}::uuid
            and w.tenant_id=${spec.assignment.tenantId}::uuid and w.deleted_at is null)
        returning creation_spec,creation_not_after`.execute(tx);
      const row = rows[0];
      if (!row || !isDeepStrictEqual(row.creation_spec, JSON.parse(encoded)))
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Allocation is closed, changed or not owned",
        );
      return { createBefore: new Date(row.creation_not_after).valueOf() };
    });
  }

  async closeAllocation(id: string, kind: AllocationKind): Promise<AllocationClosure> {
    const table = sql.table(
      kind === "terminal"
        ? "workspace_terminal_sessions"
        : kind === "development_environment"
          ? "development_environments"
          : "workspace_runtimes",
    );
    const key = sql.ref(
      kind === "terminal"
        ? "terminal_id"
        : kind === "development_environment"
          ? "allocation_id"
          : "workspace_runtime_id",
    );
    return this.#ownedTransaction(async (tx) => {
      const { rows } = await sql<{
        allocation_protocol: number | null;
        creation_not_after: Date | null;
      }>`
        update ${table} set allocation_closed=true,
          state=case when state='released' then state else ${kind === "development_environment" ? sql`case when desired_state='released' then 'releasing' else 'reconciling' end` : sql`'cleaning'`} end,
          updated_at=clock_timestamp()
        where ${key}=${id}::uuid and owner_instance_id=${this.#instanceId}::uuid and sandbox_domain_id=${this.#sandboxDomainId}
        returning allocation_protocol,creation_not_after`.execute(tx);
      const row = rows[0];
      if (!row)
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Allocation close is not owned",
        );
      if (row.allocation_protocol !== 1) return { status: "legacy" };
      if (!row.creation_not_after) return { status: "never_issued" };
      return {
        status: "authorized",
        authorization: { createBefore: new Date(row.creation_not_after).valueOf() },
      };
    });
  }

  async reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult> {
    const now = validDate(this.#clock);
    const execution = executionIdentity(input.assignment);
    return this.#ownedTransaction(async (transaction) => {
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
                "desired_state",
                "allocation_id",
                "agent_activation_id",
                "terminal_active",
              ])
              .where("tenant_id", "=", input.assignment.tenantId)
              .where("workspace_id", "=", input.assignment.workspaceId)
              .where("state", "in", [
                "requested",
                "provisioning",
                "ready",
                "releasing",
                "reconciling",
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
          liveDevelopmentEnvironment.state !== "ready" ||
          liveDevelopmentEnvironment.desired_state !== "running" ||
          liveDevelopmentEnvironment.allocation_id !== input.activationId ||
          (liveDevelopmentEnvironment.agent_activation_id !== null &&
            liveDevelopmentEnvironment.agent_activation_id !==
              liveDevelopmentEnvironment.allocation_id)
        ) {
          return { status: "busy" };
        }
        borrowedDevelopmentEnvironmentId = liveDevelopmentEnvironment.id;
        claimDevelopmentEnvironment = liveDevelopmentEnvironment.agent_activation_id === null;
      }
      const authority = await transaction
        .selectFrom("active_execution_scopes")
        .select(
          sql<string | null>`case when session_id=${input.assignment.sessionId}::uuid
            then (select compute_session_id from runs where id=${input.assignment.runId}::uuid)
            else (select s.compute_session_id from subagent_conversations v join sessions s
              on s.tenant_id=v.tenant_id and s.id=v.child_session_id
              where v.tenant_id=${input.assignment.tenantId}::uuid and v.root_run_id=${input.assignment.runId}::uuid
                and v.child_session_id=${input.assignment.sessionId}::uuid and v.child_turn_id=${input.assignment.turnId}::uuid)
            end`.as("compute_session_id"),
        )
        .select([
          "tenant_id",
          "project_id",
          "workspace_id",
          "session_id",
          "run_id",
          "turn_id",
          "worker_id",
        ])
        .where("lease_id", "=", execution.leaseId)
        .where("accepting_effects", "=", true)
        .where("run_id", "=", execution.runId)
        .where("fencing_token", "=", String(execution.fencingToken))
        .where("valid_until", ">", sql<Date>`clock_timestamp()`)
        .where(
          sql<boolean>`((session_id=${input.assignment.sessionId}::uuid and turn_id=${input.assignment.turnId}::uuid)
          or exists(select 1 from subagent_conversations v where v.tenant_id=${input.assignment.tenantId}::uuid
            and v.root_run_id=${input.assignment.runId}::uuid and v.child_session_id=${input.assignment.sessionId}::uuid
            and v.child_turn_id=${input.assignment.turnId}::uuid))`,
        )
        .executeTakeFirst();
      if (
        authority === undefined ||
        authority.tenant_id !== input.assignment.tenantId ||
        authority.project_id !== input.assignment.projectId ||
        authority.workspace_id !== input.assignment.workspaceId ||
        authority.run_id !== input.assignment.runId ||
        authority.worker_id !== input.assignment.sandboxId ||
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
            .where("state", "=", "ready")
            .where("desired_state", "=", "running")
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
        .where("state", "in", ["reserved", "materializing", "allocated", "cleaning", "unknown"])
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.owner_instance_id !== this.#instanceId) {
          return { status: "redirect", ownerBaseUrl: existing.owner_base_url };
        }
        if (
          existing.workspace_runtime_id !== input.activationId ||
          existing.environment_sha256 !== input.environmentSha256 ||
          !["reserved", "materializing", "allocated"].includes(existing.state)
        ) {
          return { status: "busy" };
        }
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
        domain.maximum_active_sandboxes !== null &&
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
    return this.#ownedTransaction(async (transaction) => {
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
        .where("state", "in", ["reserved", "materializing", "allocated", "cleaning", "unknown"])
        .executeTakeFirst();
      const developmentEnvironment = await transaction
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
        .where("state", "in", ["requested", "provisioning", "ready", "releasing", "reconciling"])
        .executeTakeFirst();
      if (developmentEnvironment !== undefined) return { status: "busy" };
      if (
        activation?.owner_instance_id !== undefined &&
        activation.owner_instance_id !== this.#instanceId
      ) {
        return { status: "redirect", ownerBaseUrl: activation.owner_base_url };
      }
      if (activation && !["reserved", "materializing", "allocated"].includes(activation.state))
        return { status: "busy" };
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
      if (domain.maximum_active_sandboxes !== null) {
        const domainReserved = await this.#domainReservedSandboxes(transaction);
        const existingWorkspaceRuntime = activation === undefined ? 0 : 1;
        if (domainReserved - existingWorkspaceRuntime >= domain.maximum_active_sandboxes)
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
    return this.#ownedTransaction(async (transaction) => {
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
        environment.profile_key !== input.profileKey ||
        environment.allocation_id !== input.allocationId ||
        Number(environment.intent_revision) !== input.intentRevision ||
        environment.desired_state !== "running" ||
        environment.allocation_closed
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Development environment identity did not match this Sandbox Domain",
        );
      }
      if (
        environment.owner_instance_id !== null &&
        environment.owner_instance_id !== this.#instanceId &&
        ["provisioning", "ready", "releasing", "reconciling"].includes(environment.state)
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
        .where("state", "in", ["reserved", "materializing", "allocated", "cleaning", "unknown"])
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
      if (
        domain.maximum_active_sandboxes !== null &&
        (await this.#domainReservedSandboxes(transaction)) >= domain.maximum_active_sandboxes
      )
        return { status: "capacity" };
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
        "allocation_id",
        "intent_revision",
        "desired_state",
        "allocation_closed",
        "allocation_absent",
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
    if (row === undefined || ["requested", "released"].includes(row.state)) {
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
        allocationId: row.allocation_id,
        intentRevision: Number(row.intent_revision),
        desiredState: row.desired_state,
        allocationClosed: row.allocation_closed,
        allocationAbsent: row.allocation_absent,
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
      return owner.state === "ready" && owner.reservation.desiredState === "running"
        ? { status: "owned" }
        : { status: "unavailable" };
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
      .where("activation.state", "in", ["materializing", "allocated", "cleaning"])
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
    identity: Pick<
      DevelopmentEnvironmentReservation,
      "environmentId" | "allocationId" | "intentRevision"
    >,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
    detail: {
      handle?: SandboxHandle;
      failureCode?: string;
      runtimeCapsule?: string | null;
      agentActive?: boolean;
    } = {},
  ): Promise<void> {
    if (detail.handle && detail.handle.activationId !== identity.allocationId)
      throw new WorkspaceRuntimeStateRepositoryError(
        "state_conflict",
        "Machine result belongs to another physical allocation",
      );
    const now = validDate(this.#clock);
    const updated = await this.#ownedTransaction(async (transaction) => {
      return transaction
        .updateTable("development_environments")
        .set({
          state,
          ...(detail.agentActive === undefined
            ? {}
            : { agent_activation_id: detail.agentActive ? identity.allocationId : null }),
          ...(state === "ready" || state === "reconciling" ? {} : { terminal_active: false }),
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
        .where("id", "=", identity.environmentId)
        .where("allocation_id", "=", identity.allocationId)
        .where("intent_revision", "=", String(identity.intentRevision))
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .$if(["ready", "provisioning"].includes(state), (q) =>
          q.where("allocation_closed", "=", false),
        )
        .$if(state === "reconciling" && detail.handle !== undefined, (query) =>
          query.where((eb) =>
            eb.or([eb("runtime_id", "is", null), eb("runtime_id", "=", detail.handle!.runtimeId)]),
          ),
        )
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
    detail: { handle?: SandboxHandle; runtimeCapsule?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#ownedTransaction(async (transaction) => {
      const returned = await transaction
        .updateTable("development_environments")
        .set({
          agent_activation_id: null,
          ...(detail.handle === undefined
            ? {}
            : {
                runtime_id: detail.handle.runtimeId,
                runtime_name: detail.handle.runtimeName,
              }),
          ...(detail.runtimeCapsule === undefined
            ? {}
            : { runtime_capsule: detail.runtimeCapsule }),
          updated_at: now,
        })
        .where("id", "=", environmentId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("agent_activation_id", "=", activationId)
        .where("allocation_id", "=", activationId)
        .executeTakeFirst();
      if (returned.numUpdatedRows !== 1n) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Development environment Agent binding is no longer current",
        );
      }
    });
  }

  async reserveDevelopmentEnvironmentTerminal(
    environmentId: string,
    allocationId: string,
  ): Promise<boolean> {
    const now = validDate(this.#clock);
    const reserved = await this.#ownedTransaction(async (transaction) => {
      return transaction
        .updateTable("development_environments")
        .set({ terminal_active: true, updated_at: now })
        .where("id", "=", environmentId)
        .where("allocation_id", "=", allocationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("desired_state", "=", "running")
        .where("terminal_active", "=", false)
        .executeTakeFirst();
    });
    return reserved.numUpdatedRows === 1n;
  }

  async releaseDevelopmentEnvironmentTerminal(
    environmentId: string,
    allocationId: string,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database
      .updateTable("development_environments")
      .set({ terminal_active: false, updated_at: now })
      .where("id", "=", environmentId)
      .where("allocation_id", "=", allocationId)
      .where("owner_instance_id", "=", this.#instanceId)
      .executeTakeFirst();
  }

  async confirmDevelopmentEnvironmentAbsent(
    identity: DevelopmentEnvironmentReservation,
  ): Promise<void> {
    await this.#ownedTransaction(async (tx) => {
      const result = await tx
        .updateTable("development_environments")
        .set({
          allocation_absent: true,
          runtime_id: null,
          runtime_name: null,
          runtime_capsule: null,
          agent_activation_id: null,
          terminal_active: false,
          updated_at: sql<Date>`clock_timestamp()`,
        })
        .where("id", "=", identity.environmentId)
        .where("allocation_id", "=", identity.allocationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("allocation_closed", "=", true)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n)
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Closed machine allocation changed",
        );
    });
  }

  async prepareDevelopmentEnvironmentImage(
    identity: DevelopmentEnvironmentReservation,
    imageRevision: string,
  ): Promise<EnvironmentRuntimeSnapshot> {
    return this.#ownedTransaction(async (tx) => {
      const current = await tx
        .selectFrom("development_environments")
        .select("id")
        .where("id", "=", identity.environmentId)
        .where("allocation_id", "=", identity.allocationId)
        .where("intent_revision", "=", String(identity.intentRevision))
        .where("owner_instance_id", "=", this.#instanceId)
        .where("desired_state", "=", "running")
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Machine image preparation is no longer authorized",
        );
      const result = await environmentForImage(tx, {
        tenantId: identity.tenantId,
        projectId: identity.projectId,
        imageRevision,
        id: randomUUID,
      });
      if (result.status !== "ready")
        throw new WorkspaceRuntimeStateRepositoryError(
          "unavailable",
          "Machine environment configuration is unavailable",
        );
      const row = result.row;
      await tx
        .updateTable("development_environments")
        .set({ environment_version_id: row.environmentVersionId })
        .where("id", "=", identity.environmentId)
        .executeTakeFirstOrThrow();
      return parseEnvironmentRuntimeSnapshot({
        environmentVersionId: row.environmentVersionId,
        versionNumber: Number(row.environmentVersionNumber),
        profileKey: row.environmentProfileKey,
        profileVersion: row.environmentProfileVersion,
        imageRevision: row.environmentImageRevision,
        specSha256: row.environmentSpecSha256,
        recipe: row.environmentRecipe,
        recipeSha256: row.environmentRecipeSha256,
      });
    });
  }

  async replaceDevelopmentEnvironmentAllocation(
    identity: DevelopmentEnvironmentReservation,
    spec: SandboxCreateSpec,
  ): Promise<DevelopmentEnvironmentReservation> {
    return this.#ownedTransaction(async (tx) => {
      const allocationId = spec.activationId;
      const result = await tx
        .updateTable("development_environments")
        .set({
          allocation_id: allocationId,
          generation: sql<string>`generation+1`,
          state: "provisioning",
          allocation_closed: false,
          allocation_absent: false,
          creation_spec: spec as unknown as Record<string, unknown>,
          creation_not_after: sql<Date>`clock_timestamp()+${SANDBOX_CREATION_WINDOW_MS}*interval '1 millisecond'`,
          runtime_id: null,
          runtime_name: null,
          runtime_capsule: null,
          failure_code: null,
          updated_at: sql<Date>`clock_timestamp()`,
        })
        .where("id", "=", identity.environmentId)
        .where("allocation_id", "=", identity.allocationId)
        .where("intent_revision", "=", String(identity.intentRevision))
        .where("desired_state", "=", "running")
        .where("owner_instance_id", "=", this.#instanceId)
        .where("allocation_closed", "=", true)
        .where("allocation_absent", "=", true)
        .where("agent_activation_id", "is", null)
        .where("terminal_active", "=", false)
        .where(
          sql<boolean>`not exists(select 1 from sandbox_tool_bindings b where b.snapshot->>'physicalActivationId'=${identity.allocationId} and not b.dispatch_closed)`,
        )
        .returning("generation")
        .executeTakeFirst();
      if (!result)
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Machine replacement is no longer authorized",
        );
      return {
        ...identity,
        allocationId,
        generation: Number(result.generation),
        allocationClosed: false,
      };
    });
  }

  async claimRecoverableWorkspaceRuntimes(
    limit: number,
    excluded: readonly string[],
  ): Promise<readonly RecoverableWorkspaceRuntime[]> {
    const bounded = positiveInteger(limit, "Workspace recovery limit");
    return this.#ownedTransaction(async (transaction) => {
      let query = transaction
        .selectFrom("workspace_runtimes as runtime")
        .leftJoin(
          "sandbox_control_instances as owner",
          "owner.instance_id",
          "runtime.owner_instance_id",
        )
        .select([
          "runtime.workspace_runtime_id",
          "runtime.tenant_id",
          "runtime.project_id",
          "runtime.workspace_id",
          "runtime.compute_session_id",
          "runtime.runtime_capsule",
          "runtime.runtime_id",
          "runtime.sandbox_profile_key",
          "runtime.creation_spec",
          "runtime.creation_not_after",
        ])
        .where("runtime.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("runtime.allocation_closed", "=", false)
        .where((eb) =>
          eb.or([
            eb("runtime.runtime_capsule", "is not", null),
            eb("runtime.creation_spec", "is not", null),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb("runtime.failure_code", "is", null),
            eb("runtime.failure_code", "not in", [
              "runtime_recovery_unconfirmed",
              "execution_stop_unconfirmed",
            ]),
          ]),
        )
        .where("runtime.state", "in", ["allocated", "unknown", "materializing"])
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
        workspace: {
          tenantId: row.tenant_id,
          projectId: row.project_id,
          workspaceId: row.workspace_id,
        },
        activationId: row.workspace_runtime_id,
        ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
        ...(row.runtime_capsule ? { runtimeCapsule: row.runtime_capsule } : {}),
        ...(row.creation_spec && row.creation_not_after
          ? {
              creation: allocationRecovery(
                row.workspace_runtime_id,
                row.creation_spec,
                row.creation_not_after,
              )!,
            }
          : {}),
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
    return this.#ownedTransaction(async (transaction) => {
      const candidates = transaction
        .selectFrom("development_environments as environment")
        .innerJoin(
          "environment_versions as config",
          "config.id",
          "environment.environment_version_id",
        )
        .innerJoin("workspaces as workspace", "workspace.id", "environment.workspace_id")
        .leftJoin("sandbox_control_instances as owner", (join) =>
          join.onRef("owner.instance_id", "=", "environment.owner_instance_id"),
        )
        .select([
          "config.version_number as configVersion",
          "config.profile_key as configProfile",
          "config.profile_version as configProfileVersion",
          "config.image_revision as imageRevision",
          "config.spec_sha256 as configSha256",
          "config.recipe as configRecipe",
          "config.recipe_sha256 as configRecipeSha256",
          "environment.id",
          "environment.tenant_id",
          "environment.owner_user_id",
          "environment.project_id",
          "environment.workspace_id",
          "environment.environment_version_id",
          "environment.allocation_id",
          "environment.intent_revision",
          "environment.desired_state",
          "environment.allocation_closed",
          "environment.allocation_absent",
          "environment.owner_instance_id",
          "environment.generation",
          "environment.profile_key",
          "environment.state",
          "environment.runtime_capsule",
          "environment.creation_spec",
          "environment.creation_not_after",
        ])
        .where("environment.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where((eb) =>
          eb.or([
            eb("workspace.deleted_at", "is", null),
            eb("environment.desired_state", "=", "released"),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.and([
              eb("environment.desired_state", "=", "paused"),
              eb("environment.allocation_absent", "=", true),
            ]),
          ),
        )
        .where("environment.state", "in", [
          "ready",
          "reconciling",
          "provisioning",
          "failed",
          "releasing",
        ])
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
        excluded.length === 0
          ? candidates
          : candidates.where((eb) =>
              eb.or([
                eb("environment.id", "not in", excluded),
                eb("environment.state", "!=", "ready"),
              ]),
            )
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
            ...(row.owner_instance_id === this.#instanceId ? {} : { terminal_active: false }),
            updated_at: now,
          })
          .where("id", "=", row.id)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) continue;
        recovered.push({
          reservation: {
            environmentId: row.id,
            allocationId: row.allocation_id,
            intentRevision: Number(row.intent_revision),
            desiredState: row.desired_state,
            tenantId: row.tenant_id,
            userId: row.owner_user_id,
            projectId: row.project_id,
            workspaceId: row.workspace_id,
            environmentVersionId: row.environment_version_id!,
            generation: Number(row.generation),
            profileKey: developmentProfileKey(row.profile_key),
            allocationClosed: row.allocation_closed,
          },
          state: row.state,
          allocationAbsent: row.allocation_absent,
          environment: parseEnvironmentRuntimeSnapshot({
            environmentVersionId: row.environment_version_id!,
            versionNumber: Number(row.configVersion),
            profileKey: row.configProfile,
            profileVersion: row.configProfileVersion,
            imageRevision: row.imageRevision,
            specSha256: row.configSha256,
            recipe: row.configRecipe,
            recipeSha256: row.configRecipeSha256,
          }),
          ...(row.runtime_capsule ? { runtimeCapsule: row.runtime_capsule } : {}),
          ...(row.creation_spec && row.creation_not_after
            ? {
                creation: allocationRecovery(
                  row.allocation_id,
                  row.creation_spec,
                  row.creation_not_after,
                )!,
              }
            : {}),
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
    const updated = await this.#ownedTransaction(async (transaction) => {
      return transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("terminal_id", "=", terminalId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .$if(["materializing", "active"].includes(state), (query) =>
          query.where("allocation_closed", "=", false),
        )
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
    return this.#ownedTransaction(async (transaction) => {
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
          and r.state in ('reserved','materializing','allocated','cleaning','unknown'))`.as(
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

  async claimWarmRuntimeRetirement(activationId: string): Promise<boolean> {
    return this.#ownedTransaction(async (transaction) => {
      const workspace = await transaction
        .selectFrom("workspaces as w")
        .innerJoin("workspace_runtimes as r", (join) =>
          join.onRef("r.tenant_id", "=", "w.tenant_id").onRef("r.workspace_id", "=", "w.id"),
        )
        .select("w.id")
        .where("r.workspace_runtime_id", "=", activationId)
        .where("r.owner_instance_id", "=", this.#instanceId)
        .forUpdate("w")
        .executeTakeFirst();
      if (!workspace) return false;
      const retired = await transaction
        .updateTable("workspace_runtimes")
        .set({ state: "cleaning", updated_at: validDate(this.#clock) })
        .where("workspace_runtime_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "allocated")
        .where(
          sql<boolean>`not exists(select 1 from sandbox_tool_bindings b where b.tenant_id=workspace_runtimes.tenant_id
          and b.snapshot->>'physicalActivationId'=workspace_runtimes.workspace_runtime_id::text and not b.dispatch_closed)`,
        )
        .where(
          sql<boolean>`not exists (
          select 1 from workspace_terminal_sessions terminal
          join sandbox_control_instances owner on owner.instance_id=terminal.owner_instance_id
          where workspace_runtimes.compute_session_id is null
            and terminal.tenant_id=workspace_runtimes.tenant_id
            and terminal.workspace_id=workspace_runtimes.workspace_id
            and terminal.state in ('reserved','materializing','active','cleaning','unknown')
            and owner.state='ready' and owner.lease_expires_at>clock_timestamp()
        )`,
        )
        .returning("workspace_runtime_id")
        .executeTakeFirst();
      return retired !== undefined;
    });
  }

  async setWorkspaceRuntimeState(
    activationId: string,
    state: SandboxControlWorkspaceRuntimeState,
    detail: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#ownedTransaction(async (transaction) => {
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
        .$if(["allocated", "materializing"].includes(state), (q) =>
          q.where("allocation_closed", "=", false),
        )
        .$if(state === "unknown" && detail.handle !== undefined, (query) =>
          query.where((eb) =>
            eb.or([eb("runtime_id", "is", null), eb("runtime_id", "=", detail.handle!.runtimeId)]),
          ),
        )
        .executeTakeFirst();
      if (result.numUpdatedRows === 1n && state === "allocated" && detail.handle !== undefined) {
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
    return this.#ownedTransaction(async (transaction) => {
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
    // least two controller lease windows before treating compute with no live
    // native-family or terminal holder as orphaned.
    const orphanedBefore = new Date(now.valueOf() - minimumUnboundAgeMs);
    return this.#ownedTransaction(async (transaction) => {
      const eligible = transaction
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
        .where("activation.state", "in", ["reserved", "materializing", "allocated"])
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where((eb) =>
          eb.or([
            // A retained conversation keeps between-Turn warm reuse. Once its
            // final reference disappears, no warm TTL or orphan grace is needed.
            sql<boolean>`not exists (
            select 1 from sessions s join workspaces w
              on w.tenant_id=s.tenant_id and w.id=s.workspace_id
            where s.tenant_id=activation.tenant_id and s.workspace_id=activation.workspace_id
              and (s.execution_mode='elastic' or s.compute_session_id is not null)
              and s.pruned_at is null and w.deleted_at is null
              and s.compute_session_id is not distinct from activation.compute_session_id
          )`,
            eb.and([
              eb("activation.state", "in", ["reserved", "materializing"]),
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
               and authority.valid_until > clock_timestamp()
               and (
                 task.compute_session_id is not distinct from activation.compute_session_id
                 or exists (
                   select 1 from subagent_executions child
                   join sessions s on s.tenant_id=child.tenant_id and s.id=child.child_session_id
                   where child.tenant_id=authority.tenant_id and child.root_run_id=authority.run_id
                     and child.state in ('preparing','running')
                     and s.compute_session_id is not distinct from activation.compute_session_id
                 )
               )
          )`,
        ).where(sql<boolean>`not exists (
          select 1 from workspace_terminal_sessions terminal
          join sandbox_control_instances owner on owner.instance_id=terminal.owner_instance_id
          where activation.compute_session_id is null
            and terminal.tenant_id=activation.tenant_id and terminal.workspace_id=activation.workspace_id
            and terminal.state in ('reserved','materializing','active','cleaning','unknown')
            and owner.state='ready' and owner.lease_expires_at>clock_timestamp()
        )`);
      // Reserve/terminal admission locks Workspace first. Select a bounded hint,
      // take the same lock, then re-read eligibility in a fresh PG statement.
      // A terminal admitted between these reads must prevent retirement.
      const hints = await eligible
        .clearSelect()
        .select("activation.workspace_id")
        .orderBy("activation.updated_at", "asc")
        .limit(boundedLimit)
        .execute();
      if (!hints.length) return [];
      const workspaces = await transaction
        .selectFrom("workspaces")
        .select("id")
        .where("id", "in", [...new Set(hints.map((row) => row.workspace_id))])
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .execute();
      if (!workspaces.length) return [];
      const rows = await eligible
        .where(
          "activation.workspace_id",
          "in",
          workspaces.map((row) => row.id),
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
    return this.#ownedTransaction(async (transaction) => {
      const rows = await transaction
        .selectFrom("workspace_runtimes as activation")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "activation.tenant_id")
            .onRef("workspace.id", "=", "activation.workspace_id"),
        )
        .select("activation.workspace_runtime_id as activationId")
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where("activation.state", "=", "allocated")
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
    await this.#reconciliation;
    // Revoke this identity before touching any resource. A locked resource
    // cannot keep a departing controller's identity Ready.
    await this.#transaction(async (transaction) => {
      await transaction
        .selectFrom("sandbox_control_instances")
        .select("instance_id")
        .where("instance_id", "=", this.#instanceId)
        .forUpdate()
        .execute();
      await transaction
        .updateTable("sandbox_control_instances")
        .set({
          state: "stopped",
          lease_expires_at: sql<Date>`clock_timestamp()`,
          updated_at: sql<Date>`clock_timestamp()`,
        })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .execute();
    });
    await this.reconcileOwnership();
  }

  /** Metadata-only maintenance. Permanent lost/stopped identities cannot renew.
   * SKIP LOCKED leaves busy resources for the existing next maintenance pass. */
  reconcileOwnership(): Promise<void> {
    return (this.#reconciliation ??= (async () => {
      await this.#transaction((tx) => this.#markExpiredOwnersLost(tx));
      for (const [table, key, states, capsule] of [
        [
          "workspace_runtimes",
          "workspace_runtime_id",
          ["reserved", "materializing", "allocated"],
          true,
        ],
        [
          "workspace_terminal_sessions",
          "terminal_id",
          ["reserved", "materializing", "active", "cleaning"],
          false,
        ],
        [
          "development_environments",
          "id",
          ["provisioning", "ready", "releasing", "reconciling"],
          true,
        ],
      ] as const) {
        await this.#transaction(async (tx) => {
          await sql`with candidates as materialized (
            select r.${sql.ref(key)} as id,r.owner_instance_id,o.state as owner_state
            from ${sql.table(table)} r join sandbox_control_instances o on o.instance_id=r.owner_instance_id
            where r.sandbox_domain_id=${this.#sandboxDomainId} and o.state in ('lost','stopped')
              and r.state in (${sql.join(states)})
              ${capsule ? sql`and r.runtime_capsule is null` : sql``}
            order by r.updated_at,r.${sql.ref(key)} limit 128 for update of r skip locked
          ) update ${sql.table(table)} as r set state=${table === "development_environments" ? "reconciling" : "unknown"},
            failure_code=case when c.owner_state='stopped' then 'tool_broker_stopped' else 'tool_broker_owner_lost' end,
            updated_at=clock_timestamp()
            from candidates c where r.${sql.ref(key)}=c.id and r.owner_instance_id=c.owner_instance_id`.execute(
            tx,
          );
        });
      }
    })().finally(() => {
      this.#reconciliation = undefined;
    }));
  }

  async #renew(): Promise<void> {
    const requestedAt = this.#monotonicNow();
    const renewed = await this.#transaction(async (transaction) => {
      // Materialize the row lock BEFORE evaluating PG expiry. Renewal never
      // depends on terminal rows or another controller's resource cleanup.
      const result = await sql<{ lease_expires_at: Date; last_heartbeat_at: Date }>`
        with owner as materialized (
          select instance_id,state,lease_expires_at from sandbox_control_instances
          where instance_id=${this.#instanceId}::uuid for no key update
        ) update sandbox_control_instances i set last_heartbeat_at=clock_timestamp(),
          lease_expires_at=clock_timestamp()+${this.#leaseMs}*interval '1 millisecond',
          updated_at=clock_timestamp() from owner o
        where i.instance_id=o.instance_id and o.state='ready' and o.lease_expires_at>clock_timestamp()
        returning i.lease_expires_at,i.last_heartbeat_at`.execute(transaction);
      return result.rows[0];
    });
    if (!renewed)
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox control ownership heartbeat was fenced",
      );
    this.#ownershipDeadline =
      requestedAt + renewed.lease_expires_at.valueOf() - renewed.last_heartbeat_at.valueOf();
  }

  get #transactionBudgetMs(): number {
    return Math.max(1, Math.min(3000, Math.floor(this.#leaseMs / 5)));
  }

  async #transaction<T>(work: (transaction: Transaction<Database>) => Promise<T>): Promise<T> {
    const total = this.#transactionBudgetMs;
    let bodyCompleted = false;
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        await sql`select
          set_config('lock_timeout',${`${Math.max(1, Math.min(500, Math.floor(total / 6)))}ms`},true),
          set_config('statement_timeout',${`${Math.max(1, Math.min(2000, Math.floor((total * 2) / 3)))}ms`},true),
          set_config('transaction_timeout',${`${total}ms`},true)`.execute(transaction);
        const result = await work(transaction);
        bodyCompleted = true;
        return result;
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      // No Cube effects occur inside work. Do not classify a lost COMMIT reply
      // as proved rollback or transparently retry a possibly committed mutation.
      if (!bodyCompleted && ["55P03", "57014", "25P04"].includes(String(code)))
        throw new WorkspaceRuntimeStateRepositoryError(
          "unavailable",
          "Sandbox lifecycle database work is busy; reconcile and retry",
          error,
        );
      throw error;
    }
  }

  async #ownedTransaction<T>(work: (transaction: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.#transaction(async (transaction) => {
      const locked = await sql<{ remaining_ms: string }>`
        with owner as materialized (
          select instance_id,state,lease_expires_at from sandbox_control_instances
          where instance_id=${this.#instanceId}::uuid for share
        ) select extract(epoch from (lease_expires_at-clock_timestamp()))*1000 as remaining_ms
          from owner where state='ready' and lease_expires_at>clock_timestamp()
      `.execute(transaction);
      if (!locked.rows.length)
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Sandbox control database ownership lease is not current",
        );
      if (Number(locked.rows[0]!.remaining_ms) <= this.#transactionBudgetMs + this.#heartbeatMs)
        throw new WorkspaceRuntimeStateRepositoryError(
          "unavailable",
          "Sandbox lifecycle admission is waiting for owner renewal",
        );
      const result = await work(transaction);
      const current = await transaction
        .selectFrom("sandbox_control_instances")
        .select("instance_id")
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!current)
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Sandbox control lease expired during lifecycle admission",
        );
      return result;
    });
  }

  async #domainReservedSandboxes(transaction: Transaction<Database>): Promise<number> {
    const result = await sql<{ count: string }>`select count(*) as count from (
      select workspace_runtime_id as id from workspace_runtimes
       where sandbox_domain_id=${this.#sandboxDomainId} and state in ('reserved','materializing','allocated','cleaning','unknown')
      union
      select id from development_environments where sandbox_domain_id=${this.#sandboxDomainId}
        and state in ('provisioning','ready','releasing','reconciling')
      union
      select t.terminal_id as id from workspace_terminal_sessions t where t.sandbox_domain_id=${this.#sandboxDomainId}
        and t.state in ('reserved','materializing','active','cleaning','unknown')
        and not exists(select 1 from workspace_runtimes r where r.tenant_id=t.tenant_id and r.workspace_id=t.workspace_id
          and r.compute_session_id is null and r.state in ('reserved','materializing','allocated','cleaning','unknown'))
    ) physical_allocations`.execute(transaction);
    return Number(result.rows[0]!.count);
  }

  async #markExpiredOwnersLost(transaction: Transaction<Database>): Promise<void> {
    await sql`with candidates as materialized (
      select instance_id from sandbox_control_instances
      where sandbox_domain_id=${this.#sandboxDomainId} and state='ready' and lease_expires_at<=clock_timestamp()
      order by instance_id limit 128 for update skip locked
    ) update sandbox_control_instances i set state='lost',updated_at=clock_timestamp()
      from candidates c where i.instance_id=c.instance_id and i.state='ready'
      and i.lease_expires_at<=clock_timestamp()`.execute(transaction);
  }
}
