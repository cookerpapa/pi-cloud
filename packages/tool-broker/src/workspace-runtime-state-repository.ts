import type {
  Database,
  DevelopmentEnvironmentState,
  ToolBrokerWorkspaceRuntimeState,
  ToolBrokerOperationState,
  WorkspaceTerminalState,
} from "@pi-cloud/database";
import {
  createExecutionLease,
  parseExecutionLease,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
} from "@pi-cloud/protocol";
import type { DevelopmentEnvironmentProfileKey, SandboxPreviewTarget } from "@pi-cloud/protocol";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "@pi-cloud/protocol";
import type { SandboxHandle } from "./sandbox-provider.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import { setTimeout as delay } from "node:timers/promises";

export type WorkspaceRuntimeReservation = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  attemptContextSha256: string;
  environmentSha256: string;
  workspaceRevision?: string;
};

function executionIdentity(assignment: ToolSandboxAssignment | SupervisorRuntimeAssignment) {
  return parseExecutionLease(assignment.executionLease);
}

export type WorkspaceRuntimeReservationResult =
  | { status: "reserved" }
  | { status: "development_environment"; environmentId: string }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "capacity" };

export type OrphanedWorkspaceRuntime = Readonly<{
  activationId: string;
  assignment: ToolSandboxAssignment;
  workspaceRevision?: string;
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
      executionLease: string;
      workspaceRuntimeId?: string;
    }
  | { status: "redirect"; ownerBaseUrl: string }
  | { status: "busy" }
  | { status: "capacity" };

export type OrphanedWorkspaceTerminal = WorkspaceTerminalReservation &
  Readonly<{ fencingToken: number }>;

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

export interface WorkspaceRuntimeStateRepository {
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
    detail?: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string | null },
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
    state: ToolBrokerWorkspaceRuntimeState,
    detail?: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string },
  ): Promise<void>;
  beginOperation(
    workspaceRuntimeId: string,
    toolBindingId: string,
    assignment: ToolSandboxAssignment,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown">;
  settleOperation(
    operationId: string,
    state: Exclude<ToolBrokerOperationState, "running">,
    failureCode?: string,
  ): Promise<void>;
  claimOrphanedWorkspaceRuntimes(limit: number): Promise<readonly OrphanedWorkspaceRuntime[]>;
  claimUnboundWorkspaceRuntimes(
    limit: number,
    minimumUnboundAgeMs?: number,
  ): Promise<readonly OrphanedWorkspaceRuntime[]>;
  listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]>;
  listRuntimeAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]>;
  releaseRuntimeAssignment(assignment: SupervisorRuntimeAssignment): Promise<void>;
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

export class InMemoryWorkspaceRuntimeStateRepository implements WorkspaceRuntimeStateRepository {
  readonly #operations = new Map<string, string>();
  readonly #terminals = new Map<string, OrphanedWorkspaceTerminal>();
  readonly #activations = new Map<string, WorkspaceRuntimeReservation>();
  readonly #developmentEnvironments = new Map<
    string,
    { reservation: DevelopmentEnvironmentReservation; state: DevelopmentEnvironmentState }
  >();

  async start(): Promise<void> {}
  async checkHealth(): Promise<void> {}
  assertLocalOwnership(): void {}
  async reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult> {
    if (
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment, state }) =>
          environment.tenantId === input.assignment.tenantId &&
          environment.workspaceId === input.assignment.workspaceId &&
          (environment.environmentId !== input.activationId || state !== "running"),
      )
    ) {
      return { status: "busy" };
    }
    this.#activations.set(input.activationId, input);
    const development = this.#developmentEnvironments.get(input.activationId);
    return development === undefined
      ? { status: "reserved" }
      : { status: "development_environment", environmentId: input.activationId };
  }
  async returnDevelopmentEnvironment(
    environmentId: string,
    activationId: string,
    outcome: "running" | "unknown",
  ): Promise<void> {
    if (environmentId !== activationId) return;
    const environment = this.#developmentEnvironments.get(environmentId);
    if (environment !== undefined) environment.state = outcome;
    this.#activations.delete(activationId);
  }
  async reserveDevelopmentEnvironmentTerminal(environmentId: string): Promise<boolean> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return environment !== undefined && environment.state === "running";
  }
  async releaseDevelopmentEnvironmentTerminal(_environmentId: string): Promise<void> {}
  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    if (
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId && environment.workspaceId === input.workspaceId,
      )
    ) {
      return { status: "busy" };
    }
    const generation =
      Math.max(
        0,
        ...[...this.#activations.values()]
          .filter(
            (activation) =>
              activation.assignment.tenantId === input.tenantId &&
              activation.assignment.workspaceId === input.workspaceId,
          )
          .map((activation) => executionIdentity(activation.assignment).fencingToken),
      ) + 1;
    const currentActivation = [...this.#activations.values()].find(
      (activation) =>
        activation.assignment.tenantId === input.tenantId &&
        activation.assignment.workspaceId === input.workspaceId,
    );
    const executionId =
      currentActivation === undefined
        ? input.terminalId
        : executionIdentity(currentActivation.assignment).attemptId;
    const executionLease = createExecutionLease(input.terminalId, executionId, generation);
    this.#terminals.set(input.terminalId, { ...input, fencingToken: generation });
    return {
      status: "reserved",
      executionLease,
      ...(currentActivation === undefined
        ? {}
        : { workspaceRuntimeId: currentActivation.activationId }),
    };
  }
  async reserveDevelopmentEnvironment(
    input: DevelopmentEnvironmentReservation,
  ): Promise<DevelopmentEnvironmentReservationResult> {
    if (
      [...this.#activations.values()].some(
        (activation) =>
          activation.assignment.tenantId === input.tenantId &&
          activation.assignment.workspaceId === input.workspaceId,
      ) ||
      [...this.#terminals.values()].some(
        (terminal) =>
          terminal.tenantId === input.tenantId && terminal.workspaceId === input.workspaceId,
      ) ||
      [...this.#developmentEnvironments.values()].some(
        ({ reservation: environment }) =>
          environment.tenantId === input.tenantId &&
          environment.workspaceId === input.workspaceId &&
          environment.environmentId !== input.environmentId,
      )
    ) {
      return { status: "busy" };
    }
    this.#developmentEnvironments.set(input.environmentId, {
      reservation: input,
      state: "running",
    });
    return { status: "reserved" };
  }
  async developmentEnvironmentOwner(
    _tenantId: string,
    _userId: string,
    environmentId: string,
  ): Promise<DevelopmentEnvironmentOwnerResult> {
    const environment = this.#developmentEnvironments.get(environmentId);
    return environment === undefined
      ? { status: "unavailable" }
      : {
          status: "owned",
          state: environment.state,
          reservation: environment.reservation,
          agentActive: false,
          terminalActive: false,
        };
  }
  async sandboxPreviewOwner(
    _tenantId: string,
    _userId: string,
    target: SandboxPreviewTarget,
  ): Promise<SandboxPreviewOwnerResult> {
    if (target.kind === "development_environment") {
      return this.#developmentEnvironments.has(target.environmentId)
        ? { status: "owned" }
        : { status: "unavailable" };
    }
    return [...this.#activations.values()].some(
      (activation) => activation.assignment.sessionId === target.sessionId,
    )
      ? { status: "owned" }
      : { status: "unavailable" };
  }
  async setDevelopmentEnvironmentState(
    environmentId: string,
    state: Exclude<DevelopmentEnvironmentState, "requested">,
  ): Promise<void> {
    const environment = this.#developmentEnvironments.get(environmentId);
    if (state === "released" || state === "failed") {
      this.#developmentEnvironments.delete(environmentId);
    } else if (environment !== undefined) {
      environment.state = state;
    }
  }
  async claimRecoverableDevelopmentEnvironments(): Promise<
    readonly RecoverableDevelopmentEnvironment[]
  > {
    return [];
  }
  async claimOrphanedDevelopmentEnvironments(): Promise<
    readonly DevelopmentEnvironmentReservation[]
  > {
    return [];
  }
  async setTerminalState(terminalId: string, state: WorkspaceTerminalState): Promise<void> {
    if (state === "released") this.#terminals.delete(terminalId);
  }
  async claimOrphanedTerminals(): Promise<readonly OrphanedWorkspaceTerminal[]> {
    return [];
  }
  async setWorkspaceRuntimeState(
    activationId: string,
    state: ToolBrokerWorkspaceRuntimeState,
    _detail?: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string },
  ): Promise<void> {
    if (state === "released") this.#activations.delete(activationId);
  }
  async beginOperation(
    _activationId: string,
    _toolBindingId: string,
    _assignment: ToolSandboxAssignment,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown"> {
    const existing = this.#operations.get(operationId);
    if (existing !== undefined) return "unknown";
    this.#operations.set(operationId, requestSha256);
    return "started";
  }
  async settleOperation(): Promise<void> {}
  async claimOrphanedWorkspaceRuntimes(): Promise<readonly OrphanedWorkspaceRuntime[]> {
    return [];
  }
  async claimUnboundWorkspaceRuntimes(): Promise<readonly OrphanedWorkspaceRuntime[]> {
    return [];
  }
  async listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]> {
    return [];
  }
  async listRuntimeAssignments(): Promise<readonly SupervisorRuntimeAssignment[]> {
    return [];
  }
  async releaseRuntimeAssignment(): Promise<void> {}
  async close(): Promise<void> {}
}

export type PostgresWorkspaceRuntimeStateRepositoryOptions = {
  database: Kysely<Database>;
  sandboxDomainId: string;
  instanceId: string;
  ownerBaseUrl: string;
  leaseMs?: number;
  heartbeatMs?: number;
  clock?: () => Date;
};

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Tool Broker state clock returned an invalid date");
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
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;
  #confirmedLeaseExpiresAt = 0;

  constructor(options: PostgresWorkspaceRuntimeStateRepositoryOptions) {
    this.#database = options.database;
    this.#sandboxDomainId = options.sandboxDomainId;
    this.#instanceId = options.instanceId;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#leaseMs = positiveInteger(options.leaseMs ?? 15_000, "leaseMs");
    this.#heartbeatMs = positiveInteger(options.heartbeatMs ?? 5_000, "heartbeatMs");
    if (this.#heartbeatMs * 2 >= this.#leaseMs) {
      throw new TypeError("Tool Broker heartbeat must leave lease failure margin");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.#heartbeat !== undefined || this.#closed) {
      throw new Error("Tool Broker state repository can only start once");
    }
    const startupDeadline = Date.now() + this.#leaseMs * 2;
    let leaseExpiresAt: Date | undefined;
    while (leaseExpiresAt === undefined) {
      const now = validDate(this.#clock);
      const candidateLease = new Date(now.valueOf() + this.#leaseMs);
      const currentOwner = await this.#database
        .selectFrom("tool_broker_instances")
        .select("lease_expires_at")
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("owner_base_url", "=", this.#ownerBaseUrl)
        .where("state", "=", "ready")
        .executeTakeFirst();
      const currentOwnerLease =
        currentOwner === undefined
          ? undefined
          : timestampValue(currentOwner.lease_expires_at, "Tool Broker owner lease");
      if (currentOwnerLease !== undefined && currentOwnerLease > now.valueOf()) {
        if (Date.now() >= startupDeadline) {
          throw new WorkspaceRuntimeStateRepositoryError(
            "ownership_lost",
            "Tool Broker owner URL is still leased by another instance",
          );
        }
        await delay(
          Math.min(this.#heartbeatMs, Math.max(25, currentOwnerLease - now.valueOf() + 10)),
        );
        continue;
      }
      try {
        await this.#database.transaction().execute(async (transaction) => {
          await this.#markExpiredOwnersLost(transaction, now);
          await transaction
            .insertInto("tool_broker_instances")
            .values({
              instance_id: this.#instanceId,
              sandbox_domain_id: this.#sandboxDomainId,
              owner_base_url: this.#ownerBaseUrl,
              state: "ready",
              lease_expires_at: candidateLease,
              last_heartbeat_at: now,
              updated_at: now,
            })
            .executeTakeFirstOrThrow();
        });
        leaseExpiresAt = candidateLease;
      } catch (error: unknown) {
        if (!readyOwnerUrlConflict(error) || Date.now() >= startupDeadline) throw error;
        const existing = await this.#database
          .selectFrom("tool_broker_instances")
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
              : timestampValue(existing.lease_expires_at, "Tool Broker owner lease")) -
              now.valueOf() +
              10,
          ),
        );
        await delay(waitMs);
      }
    }
    this.#confirmedLeaseExpiresAt = leaseExpiresAt.valueOf();
    this.#heartbeat = setInterval(
      () => void this.#renew().catch(() => undefined),
      this.#heartbeatMs,
    );
    this.#heartbeat.unref();
  }

  async checkHealth(): Promise<void> {
    const now = validDate(this.#clock);
    const row = await this.#database
      .selectFrom("tool_broker_instances")
      .select("lease_expires_at")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (row === undefined) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Tool Broker database ownership lease is not current",
      );
    }
    this.#confirmedLeaseExpiresAt = timestampValue(
      row.lease_expires_at,
      "Tool Broker confirmed lease",
    );
  }

  assertLocalOwnership(): void {
    const now = validDate(this.#clock);
    if (this.#closed || now.valueOf() >= this.#confirmedLeaseExpiresAt) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Tool Broker locally confirmed ownership lease expired",
      );
    }
  }

  async reserve(input: WorkspaceRuntimeReservation): Promise<WorkspaceRuntimeReservationResult> {
    const now = validDate(this.#clock);
    const execution = executionIdentity(input.assignment);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
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
      const liveTerminal = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select(["owner_instance_id", "owner_base_url"])
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirst();
      if (liveTerminal !== undefined && liveTerminal.owner_instance_id !== this.#instanceId) {
        return { status: "redirect", ownerBaseUrl: liveTerminal.owner_base_url };
      }
      const liveDevelopmentEnvironment = await transaction
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
        .selectFrom("session_leases")
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
        .where("attempt_id", "=", execution.attemptId)
        .where("fencing_token", "=", String(execution.fencingToken))
        .where("valid_until", ">", now)
        .executeTakeFirst();
      if (
        authority === undefined ||
        authority.tenant_id !== input.assignment.tenantId ||
        authority.project_id !== input.assignment.projectId ||
        authority.workspace_id !== input.assignment.workspaceId ||
        authority.session_id !== input.assignment.sessionId ||
        authority.run_id !== input.assignment.runId ||
        authority.turn_id !== input.assignment.turnId ||
        authority.sandbox_id !== input.assignment.sandboxId
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Tool binding reserve used a stale ExecutionLease",
        );
      }
      const existing = await transaction
        .selectFrom("tool_broker_workspace_runtimes")
        .selectAll()
        .where("tenant_id", "=", input.assignment.tenantId)
        .where("workspace_id", "=", input.assignment.workspaceId)
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
          .updateTable("tool_broker_workspace_runtimes")
          .set({
            state: existing.state === "warm" ? "reserved" : existing.state,
            failure_code: null,
            updated_at: now,
          })
          .where("workspace_runtime_id", "=", input.activationId)
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "=", existing.state)
          .executeTakeFirstOrThrow();
        return borrowedDevelopmentEnvironmentId === undefined
          ? { status: "reserved" }
          : {
              status: "development_environment",
              environmentId: borrowedDevelopmentEnvironmentId,
            };
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
      const live = await transaction
        .selectFrom("tool_broker_workspace_runtimes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow();
      const terminalLive = await transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow();
      const domainDevelopmentEnvironments = await transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow();
      if (
        borrowedDevelopmentEnvironmentId === undefined &&
        liveTerminal === undefined &&
        Number(live.count) +
          Number(terminalLive.count) +
          Number(domainDevelopmentEnvironments.count) >=
          domain.maximum_active_sandboxes
      ) {
        return { status: "capacity" };
      }
      if (borrowedDevelopmentEnvironmentId !== undefined && claimDevelopmentEnvironment) {
        const lent = await transaction
          .updateTable("development_environments")
          .set({ agent_activation_id: input.activationId, updated_at: now })
          .where("id", "=", borrowedDevelopmentEnvironmentId)
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "=", "running")
          .where("agent_activation_id", "is", null)
          .executeTakeFirst();
        if (lent.numUpdatedRows !== 1n) return { status: "busy" };
      }
      const activationValues = {
        workspace_runtime_id: input.activationId,
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
        attempt_id: execution.attemptId,
        lease_id: execution.leaseId,
        fencing_token: execution.fencingToken,
        turn_context_sha256: input.turnContextSha256,
        attempt_context_sha256: input.attemptContextSha256,
        environment_sha256: input.environmentSha256,
        workspace_revision: input.workspaceRevision ?? null,
        runtime_id: null,
        runtime_name: null,
        state: "reserved",
        failure_code: null,
        updated_at: now,
      } as const;
      const retiredActivation = await transaction
        .selectFrom("tool_broker_workspace_runtimes")
        .select(["tenant_id", "project_id", "workspace_id", "state"])
        .where("workspace_runtime_id", "=", input.activationId)
        .forUpdate()
        .executeTakeFirst();
      if (retiredActivation === undefined) {
        await transaction
          .insertInto("tool_broker_workspace_runtimes")
          .values(activationValues)
          .executeTakeFirstOrThrow();
      } else {
        if (
          borrowedDevelopmentEnvironmentId === undefined ||
          retiredActivation.tenant_id !== input.assignment.tenantId ||
          retiredActivation.project_id !== input.assignment.projectId ||
          retiredActivation.workspace_id !== input.assignment.workspaceId ||
          retiredActivation.state !== "released"
        ) {
          throw new WorkspaceRuntimeStateRepositoryError(
            "state_conflict",
            "Workspace runtime identity was already used by another resource",
          );
        }
        await transaction
          .updateTable("tool_broker_workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            supervisor_id: input.assignment.supervisorId,
            boot_id: input.assignment.bootId,
            sandbox_id: input.assignment.sandboxId,
            run_id: input.assignment.runId,
            session_id: input.assignment.sessionId,
            turn_id: input.assignment.turnId,
            attempt_id: execution.attemptId,
            lease_id: execution.leaseId,
            fencing_token: execution.fencingToken,
            turn_context_sha256: input.turnContextSha256,
            attempt_context_sha256: input.attemptContextSha256,
            environment_sha256: input.environmentSha256,
            workspace_revision: input.workspaceRevision ?? null,
            runtime_id: null,
            runtime_name: null,
            state: "reserved",
            failure_code: null,
            updated_at: now,
          })
          .where("workspace_runtime_id", "=", input.activationId)
          .where("state", "=", "released")
          .executeTakeFirstOrThrow();
      }
      return borrowedDevelopmentEnvironmentId === undefined
        ? { status: "reserved" }
        : {
            status: "development_environment",
            environmentId: borrowedDevelopmentEnvironmentId,
          };
    });
  }

  async reserveTerminal(
    input: WorkspaceTerminalReservation,
  ): Promise<WorkspaceTerminalReservationResult> {
    const now = validDate(this.#clock);
    const leaseExpiresAt = new Date(now.valueOf() + this.#leaseMs);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["sandbox_domain_id", "project_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.workspaceId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (
        workspace?.sandbox_domain_id !== this.#sandboxDomainId ||
        workspace.project_id !== input.projectId
      ) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal identity did not match this Sandbox Domain",
        );
      }
      const session = await transaction
        .selectFrom("sessions")
        .select(["id", "last_fencing_token"])
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.sessionId)
        .where("workspace_id", "=", input.workspaceId)
        .where("archived_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "state_conflict",
          "Workspace terminal Session was unavailable",
        );
      }
      const activation = await transaction
        .selectFrom("tool_broker_workspace_runtimes")
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
          "attempt_id",
          "lease_id",
          "fencing_token",
          "workspace_revision",
        ])
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
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
        Number(session.last_fencing_token),
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
      const executionLease = createExecutionLease(
        input.terminalId,
        activation?.attempt_id ?? input.terminalId,
        generation,
      );
      return {
        status: "reserved",
        executionLease,
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
      await this.#assertCurrentOwner(transaction, now);
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
        .selectFrom("tool_broker_workspace_runtimes")
        .select("workspace_runtime_id")
        .where("tenant_id", "=", input.tenantId)
        .where("workspace_id", "=", input.workspaceId)
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
    const now = validDate(this.#clock);
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
              .selectFrom("tool_broker_instances")
              .select("owner_base_url")
              .where("instance_id", "=", row.owner_instance_id)
              .where("state", "=", "ready")
              .where("lease_expires_at", ">", now)
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
      .innerJoin("tool_broker_workspace_runtimes as activation", (join) =>
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
      .where("session_row.archived_at", "is", null)
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
    detail: { handle?: SandboxHandle; failureCode?: string; runtimeCapsule?: string | null } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("development_environments")
        .set({
          state,
          ...(state === "running" ? {} : { terminal_active: false }),
          ...(state === "released" ? { owner_instance_id: null, owner_base_url: null } : {}),
          ...(state === "released"
            ? { runtime_id: null, runtime_name: null }
            : (state === "unknown" || state === "releasing") && detail.handle === undefined
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
      await this.#assertCurrentOwner(transaction, now);
      const returned = await transaction
        .updateTable("development_environments")
        .set({
          agent_activation_id: null,
          state: outcome,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          runtime_capsule: detail.runtimeCapsule ?? null,
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
      await transaction
        .updateTable("tool_broker_workspace_runtimes")
        .set({ state: "released", runtime_id: null, runtime_name: null, updated_at: now })
        .where("workspace_runtime_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .executeTakeFirstOrThrow();
    });
  }

  async reserveDevelopmentEnvironmentTerminal(environmentId: string): Promise<boolean> {
    const now = validDate(this.#clock);
    const reserved = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
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
      await this.#assertCurrentOwner(transaction, now);
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
            state: "releasing",
            runtime_id: null,
            runtime_name: null,
            failure_code: "tool_broker_owner_lost",
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

  async claimRecoverableDevelopmentEnvironments(
    limit: number,
    excludeEnvironmentIds: readonly string[] = [],
  ): Promise<readonly RecoverableDevelopmentEnvironment[]> {
    const boundedLimit = positiveInteger(limit, "development environment recovery limit");
    const excluded = [...new Set(excludeEnvironmentIds)];
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const candidates = transaction
        .selectFrom("development_environments as environment")
        .leftJoin("tool_broker_instances as owner", (join) =>
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
        .where("environment.agent_activation_id", "is", null)
        .where("environment.terminal_active", "=", false)
        .where((expression) =>
          expression.or([
            expression("environment.owner_instance_id", "=", this.#instanceId),
            expression("owner.instance_id", "is", null),
            expression("owner.state", "!=", "ready"),
            expression("owner.lease_expires_at", "<=", now),
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
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("workspace_terminal_sessions")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
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
      await this.#assertCurrentOwner(transaction, now);
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
            lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
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
      }));
    });
  }

  async setWorkspaceRuntimeState(
    activationId: string,
    state: ToolBrokerWorkspaceRuntimeState,
    detail: { handle?: SandboxHandle; workspaceRevision?: string; failureCode?: string } = {},
  ): Promise<void> {
    const now = validDate(this.#clock);
    const updated = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("tool_broker_workspace_runtimes")
        .set({
          state,
          runtime_id: detail.handle?.runtimeId ?? null,
          runtime_name: detail.handle?.runtimeName ?? null,
          ...(detail.workspaceRevision === undefined
            ? {}
            : { workspace_revision: detail.workspaceRevision }),
          failure_code: failureCode(detail.failureCode),
          updated_at: now,
        })
        .where("workspace_runtime_id", "=", activationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "!=", "released")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Workspace runtime ownership is no longer current",
      );
    }
  }

  async beginOperation(
    workspaceRuntimeId: string,
    toolBindingId: string,
    assignment: ToolSandboxAssignment,
    operationId: string,
    requestSha256: string,
  ): Promise<"started" | "unknown"> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const execution = executionIdentity(assignment);
      const activation = await transaction
        .selectFrom("tool_broker_workspace_runtimes as activation")
        .innerJoin("session_leases as authority", (join) =>
          join
            .onRef("authority.tenant_id", "=", "activation.tenant_id")
            .onRef("authority.project_id", "=", "activation.project_id")
            .onRef("authority.workspace_id", "=", "activation.workspace_id"),
        )
        .select("activation.workspace_runtime_id")
        .where("activation.workspace_runtime_id", "=", workspaceRuntimeId)
        .where("activation.owner_instance_id", "=", this.#instanceId)
        .where("activation.state", "in", ["reserved", "materializing", "active"])
        .where("authority.lease_id", "=", execution.leaseId)
        .where("authority.attempt_id", "=", execution.attemptId)
        .where("authority.fencing_token", "=", String(execution.fencingToken))
        .where("authority.session_id", "=", assignment.sessionId)
        .where("authority.run_id", "=", assignment.runId)
        .where("authority.turn_id", "=", assignment.turnId)
        .where("authority.sandbox_id", "=", assignment.sandboxId)
        .where("authority.valid_until", ">", now)
        .forUpdate()
        .executeTakeFirst();
      if (activation === undefined) {
        throw new WorkspaceRuntimeStateRepositoryError(
          "ownership_lost",
          "Workspace runtime is not executable by this owner",
        );
      }
      const existing = await transaction
        .selectFrom("tool_broker_operations")
        .select("operation_id")
        .where("operation_id", "=", operationId)
        .executeTakeFirst();
      if (existing !== undefined) return "unknown";
      await transaction
        .insertInto("tool_broker_operations")
        .values({
          operation_id: operationId,
          workspace_runtime_id: workspaceRuntimeId,
          tool_binding_id: toolBindingId,
          tenant_id: assignment.tenantId,
          session_id: assignment.sessionId,
          run_id: assignment.runId,
          attempt_id: execution.attemptId,
          lease_id: execution.leaseId,
          fencing_token: execution.fencingToken,
          owner_instance_id: this.#instanceId,
          request_sha256: requestSha256,
          state: "running",
          failure_code: null,
          started_at: now,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      return "started";
    });
  }

  async settleOperation(
    operationId: string,
    state: Exclude<ToolBrokerOperationState, "running">,
    code?: string,
  ): Promise<void> {
    const now = validDate(this.#clock);
    const settled = await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      return transaction
        .updateTable("tool_broker_operations")
        .set({
          state,
          failure_code: failureCode(code),
          settled_at: sql<Date>`greatest(${sql.ref("started_at")}, ${now})`,
        })
        .where("operation_id", "=", operationId)
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .executeTakeFirst();
    });
    if (settled.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Sandbox operation ownership is no longer current",
      );
    }
  }

  async claimOrphanedWorkspaceRuntimes(
    limit: number,
  ): Promise<readonly OrphanedWorkspaceRuntime[]> {
    const boundedLimit = positiveInteger(limit, "orphan cleanup limit");
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("tool_broker_workspace_runtimes")
        .select([
          "workspace_runtime_id",
          "tenant_id",
          "project_id",
          "workspace_id",
          "supervisor_id",
          "boot_id",
          "sandbox_id",
          "run_id",
          "session_id",
          "turn_id",
          "attempt_id",
          "lease_id",
          "fencing_token",
        ])
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "=", "unknown")
        .orderBy("updated_at", "asc")
        .limit(boundedLimit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await transaction
          .updateTable("tool_broker_workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            updated_at: now,
          })
          .where("workspace_runtime_id", "=", row.workspace_runtime_id)
          .where("state", "=", "unknown")
          .executeTakeFirstOrThrow();
      }
      return rows.map((row) => ({
        activationId: row.workspace_runtime_id,
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
          executionLease: createExecutionLease(
            row.lease_id,
            row.attempt_id,
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
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("tool_broker_workspace_runtimes as activation")
        .select([
          "activation.workspace_runtime_id",
          "activation.tenant_id",
          "activation.project_id",
          "activation.workspace_id",
          "activation.supervisor_id",
          "activation.boot_id",
          "activation.sandbox_id",
          "activation.run_id",
          "activation.session_id",
          "activation.turn_id",
          "activation.attempt_id",
          "activation.lease_id",
          "activation.fencing_token",
        ])
        .where("activation.sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("activation.state", "in", ["reserved", "materializing", "active"])
        .where("activation.updated_at", "<", orphanedBefore)
        .where(
          sql<boolean>`not exists (
            select 1
              from session_leases authority
             where authority.tenant_id = ${sql.ref("activation.tenant_id")}
               and authority.project_id = ${sql.ref("activation.project_id")}
               and authority.workspace_id = ${sql.ref("activation.workspace_id")}
               and authority.valid_until > ${now}
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
          .updateTable("tool_broker_workspace_runtimes")
          .set({
            owner_instance_id: this.#instanceId,
            owner_base_url: this.#ownerBaseUrl,
            state: "cleaning",
            failure_code: "workspace_runtime_unbound",
            updated_at: now,
          })
          .where("workspace_runtime_id", "in", activationIds)
          .execute();
        await transaction
          .updateTable("tool_broker_operations")
          .set({
            state: "failed",
            failure_code: "workspace_runtime_unbound",
            settled_at: now,
          })
          .where("workspace_runtime_id", "in", activationIds)
          .where("state", "=", "running")
          .execute();
      }
      return rows.map((row) => ({
        activationId: row.workspace_runtime_id,
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
          executionLease: createExecutionLease(
            row.lease_id,
            row.attempt_id,
            Number(row.fencing_token),
          ),
        },
      }));
    });
  }

  async listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      const rows = await transaction
        .selectFrom("tool_broker_workspace_runtimes as activation")
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

  async listRuntimeAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const rows = await this.#database
      .selectFrom("tool_broker_workspace_runtimes")
      .select([
        "runtime_id",
        "runtime_name",
        "supervisor_id",
        "boot_id",
        "sandbox_id",
        "run_id",
        "workspace_id",
        "session_id",
        "turn_id",
        "attempt_id",
        "lease_id",
        "fencing_token",
      ])
      .where("sandbox_domain_id", "=", this.#sandboxDomainId)
      .where("sandbox_id", "=", sandboxId)
      // Warm process worlds are owned by the Tool Broker, not by the expired
      // Supervisor Run lease. Publishing them through Supervisor inventory
      // makes AssignmentReconciler misclassify and destroy them as orphans.
      .where("state", "=", "active")
      .where("runtime_id", "is not", null)
      .where("runtime_name", "is not", null)
      .execute();
    return rows.map((row) => ({
      containerId: row.runtime_id!,
      containerName: row.runtime_name!,
      supervisorId: row.supervisor_id,
      bootId: row.boot_id,
      sandboxId: row.sandbox_id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      executionLease: createExecutionLease(row.lease_id, row.attempt_id, Number(row.fencing_token)),
    }));
  }

  async releaseRuntimeAssignment(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const now = validDate(this.#clock);
    const execution = executionIdentity(assignment);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#assertCurrentOwner(transaction, now);
      await transaction
        .updateTable("tool_broker_workspace_runtimes")
        .set({ state: "released", failure_code: null, updated_at: now })
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("supervisor_id", "=", assignment.supervisorId)
        .where("boot_id", "=", assignment.bootId)
        .where("sandbox_id", "=", assignment.sandboxId)
        .where("run_id", "=", assignment.runId)
        .where("workspace_id", "=", assignment.workspaceId)
        .where("session_id", "=", assignment.sessionId)
        .where("turn_id", "=", assignment.turnId)
        .where("lease_id", "=", execution.leaseId)
        .where("fencing_token", "=", String(execution.fencingToken))
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
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
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#confirmedLeaseExpiresAt = 0;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("tool_broker_operations")
        .set({ state: "unknown", failure_code: "tool_broker_stopped", settled_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "=", "running")
        .execute();
      await transaction
        .updateTable("tool_broker_workspace_runtimes")
        .set({ state: "unknown", failure_code: "tool_broker_stopped", updated_at: now })
        .where("owner_instance_id", "=", this.#instanceId)
        .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
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
        .updateTable("tool_broker_instances")
        .set({ state: "stopped", lease_expires_at: now, updated_at: now })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .execute();
    });
  }

  async #renew(): Promise<void> {
    const now = validDate(this.#clock);
    const renewed = await this.#database.transaction().execute(async (transaction) => {
      await this.#markExpiredOwnersLost(transaction, now);
      const owner = await transaction
        .updateTable("tool_broker_instances")
        .set({
          last_heartbeat_at: now,
          lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
          updated_at: now,
        })
        .where("instance_id", "=", this.#instanceId)
        .where("state", "=", "ready")
        .where("lease_expires_at", ">", now)
        .executeTakeFirst();
      if (owner.numUpdatedRows === 1n) {
        await transaction
          .updateTable("workspace_terminal_sessions")
          .set({
            lease_expires_at: new Date(now.valueOf() + this.#leaseMs),
            last_heartbeat_at: now,
            updated_at: now,
          })
          .where("owner_instance_id", "=", this.#instanceId)
          .where("state", "in", ["reserved", "materializing", "active", "cleaning"])
          .execute();
      }
      return owner;
    });
    if (renewed.numUpdatedRows !== 1n) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Tool Broker ownership heartbeat was fenced",
      );
    }
    this.#confirmedLeaseExpiresAt = now.valueOf() + this.#leaseMs;
  }

  async #assertCurrentOwner(transaction: Transaction<Database>, now: Date): Promise<void> {
    const owner = await transaction
      .selectFrom("tool_broker_instances")
      .select("instance_id")
      .where("instance_id", "=", this.#instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", now)
      .executeTakeFirst();
    if (owner === undefined) {
      throw new WorkspaceRuntimeStateRepositoryError(
        "ownership_lost",
        "Tool Broker database ownership lease is not current",
      );
    }
  }

  async #domainReservedSandboxes(transaction: Transaction<Database>): Promise<number> {
    const [activations, terminals, environments] = await Promise.all([
      transaction
        .selectFrom("tool_broker_workspace_runtimes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", [
          "reserved",
          "materializing",
          "active",
          "warm",
          "cleaning",
          "unknown",
        ])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("workspace_terminal_sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("development_environments")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("sandbox_domain_id", "=", this.#sandboxDomainId)
        .where("state", "in", ["provisioning", "running", "paused", "releasing", "unknown"])
        .executeTakeFirstOrThrow(),
    ]);
    return Number(activations.count) + Number(terminals.count) + Number(environments.count);
  }

  async #markExpiredOwnersLost(transaction: Transaction<Database>, now: Date): Promise<void> {
    const lostInstances = await transaction
      .updateTable("tool_broker_instances")
      .set({ state: "lost", updated_at: now })
      .where("sandbox_domain_id", "=", this.#sandboxDomainId)
      .where("state", "=", "ready")
      .where("lease_expires_at", "<=", now)
      .returning("instance_id")
      .execute();
    const lostIds = lostInstances.map((instance) => instance.instance_id);
    if (lostIds.length === 0) return;
    await transaction
      .updateTable("tool_broker_operations")
      .set({ state: "unknown", failure_code: "tool_broker_owner_lost", settled_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "=", "running")
      .execute();
    await transaction
      .updateTable("tool_broker_workspace_runtimes")
      .set({ state: "unknown", failure_code: "tool_broker_owner_lost", updated_at: now })
      .where("owner_instance_id", "in", lostIds)
      .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning"])
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
