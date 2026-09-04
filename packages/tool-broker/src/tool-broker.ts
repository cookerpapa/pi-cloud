import type {
  AgentWorkspaceSeed,
  DevelopmentEnvironmentBrokerResponse,
  DevelopmentEnvironmentBrokerRequest,
  DevelopmentEnvironmentLifecycleRequest,
  DevelopmentEnvironmentProvisionRequest,
  DevelopmentEnvironmentTerminalOpenRequest,
  EnvironmentRuntimeSnapshot,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxCreateRequest,
  ToolSandboxCreateResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
  ToolSandboxReleaseRequest,
  ToolSandboxReleaseResponse,
  ToolBrokerListWorkspaceDirectoryRequest,
  ToolBrokerListWorkspaceDirectoryResponse,
  ToolBrokerReadWorkspaceFileRequest,
  ToolBrokerReadWorkspaceFileResponse,
  ToolBrokerWorkspaceForkRequest,
  ToolBrokerWorkspaceForkResponse,
  CloudToolName,
  SandboxPreviewRequest,
  SandboxPreviewResponse,
  SourceControlWorkspaceCredentialAuthorizeRequest,
  SourceControlWorkspaceCredentialDisconnectRequest,
  SourceControlWorkspaceCredentialDisconnectResponse,
  SourceControlWorkspaceCredentialListRequest,
  SourceControlWorkspaceCredentialListResponse,
  SourceControlWorkspaceCredentialPreflightRequest,
  SourceControlWorkspaceCredentialResponse,
} from "@pi-cloud/protocol";
import {
  createExecutionLease,
  parseCloudToolCapabilitySnapshot,
  parseExecutionLease,
} from "@pi-cloud/protocol";
import {
  canonicalEnvironmentRecipeJson,
  DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  ToolBrokerError,
  type SandboxHandle,
  type SandboxInspection,
  type SandboxProvider,
  type SandboxTerminalSession,
  type SandboxTerminalSize,
} from "./sandbox-provider.ts";
import {
  type WorkspaceRuntimeReservation,
  type WorkspaceRuntimeStateRepository,
  type DevelopmentEnvironmentReservation,
} from "./workspace-runtime-state-repository.ts";
import type {
  SandboxHttpServiceRegistry,
  SandboxHttpServiceTarget,
} from "./sandbox-http-service-registry.ts";

export type ToolBrokerOptions = {
  provider: SandboxProvider;
  ownerBaseUrl: string;
  stateRepository: WorkspaceRuntimeStateRepository;
  idGenerator?: () => string;
  maximumActiveSandboxes?: number;
  warmTtlMs?: number;
  maximumWarmWorkspaceRuntimes?: number;
  clock?: () => number;
  imageRevision: string;
  serviceRegistry?: SandboxHttpServiceRegistry;
  onMaintenanceError?: (error: unknown) => void;
};

export class ToolBrokerOwnerRedirectError extends Error {
  readonly ownerBaseUrl: string;

  constructor(ownerBaseUrl: string) {
    super("Tool binding is owned by another Tool Broker replica");
    this.name = "ToolBrokerOwnerRedirectError";
    this.ownerBaseUrl = ownerBaseUrl;
  }
}

type ManagedToolBinding = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  attemptContextSha256: string;
  currentStep?: Readonly<{ sequence: number; sha256: string }>;
  allowedTools: ReadonlySet<CloudToolName>;
  spec: Parameters<SandboxProvider["create"]>[0];
  reservation: WorkspaceRuntimeReservation;
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  usedPhysicalRuntime: boolean;
  activeOperations: number;
  exclusiveOperation: boolean;
  operations: Map<
    string,
    Readonly<{
      requestSha256: string;
      result: Promise<ToolSandboxOperationResponse>;
      controller: AbortController;
    }>
  >;
  seenCaptureIds: Set<string>;
  elasticRuntime?: ManagedElasticRuntime;
  developmentEnvironmentId?: string;
};

type ManagedElasticRuntime = {
  physicalActivationId: string;
  workspaceKey: string;
  spec: Parameters<SandboxProvider["create"]>[0];
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  bindingIds: Set<string>;
  initialBindingIssued: boolean;
  activeOperations: number;
  exclusiveOperation: boolean;
  workspaceRevision: string;
  environment: EnvironmentRuntimeSnapshot;
  sandboxProfileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
  expiresAt: number;
  lastUsedAt: number;
  workspaceTerminalId?: string;
  failure?: ToolBrokerError;
};

export type WorkspaceTerminalOpenInput = Readonly<{
  tenantId: string;
  userId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  environment: EnvironmentRuntimeSnapshot;
  workspaceSeed: AgentWorkspaceSeed;
  size: SandboxTerminalSize;
}>;

export type WorkspaceTerminalConnection = Readonly<{
  terminalId: string;
  pid: number;
  workspaceRoot: string;
  output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: SandboxTerminalSize): Promise<void>;
  close(): Promise<void>;
}>;

type ManagedWorkspaceTerminal = {
  assignment: ToolSandboxAssignment;
  handle: SandboxHandle;
  session: SandboxTerminalSession;
  workspaceRuntime?: ManagedElasticRuntime;
  closing?: Promise<void>;
};

type ManagedDevelopmentEnvironment = {
  reservation: DevelopmentEnvironmentReservation;
  assignment: ToolSandboxAssignment;
  handle: SandboxHandle;
  terminal?: SandboxTerminalSession;
  bindingIds: Set<string>;
};

type AdmissionWaiter = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: ToolBrokerError) => void;
  abort?: () => void;
};

const DEFAULT_WARM_TTL_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_WARM_WORKSPACE_RUNTIMES = 4;
const DEFAULT_MAXIMUM_ACTIVE_SANDBOXES = 2;

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function workspaceIdentityKey(assignment: ToolSandboxAssignment): string {
  return [assignment.tenantId, assignment.projectId, assignment.workspaceId].join("\0");
}

function operationFailureCode(error: unknown): string {
  return error instanceof ToolBrokerError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : "tool_broker_failed";
}

const TOOL_OPERATIONS: Readonly<Record<CloudToolName, ReadonlySet<string>>> = {
  read: new Set(["file.read", "file.read_range", "file.access"]),
  write: new Set(["file.write", "file.mkdir"]),
  edit: new Set(["file.read", "file.write", "file.access"]),
  bash: new Set(["bash.exec"]),
};

function sameEnvironment(
  left: EnvironmentRuntimeSnapshot,
  right: EnvironmentRuntimeSnapshot,
): boolean {
  return (
    left.environmentVersionId === right.environmentVersionId &&
    left.versionNumber === right.versionNumber &&
    left.profileKey === right.profileKey &&
    left.profileVersion === right.profileVersion &&
    left.imageRevision === right.imageRevision &&
    left.specSha256 === right.specSha256 &&
    left.recipeSha256 === right.recipeSha256 &&
    canonicalEnvironmentRecipeJson(left.recipe) === canonicalEnvironmentRecipeJson(right.recipe)
  );
}

function validActivationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("Tool Broker ID generator returned an invalid UUID");
  }
  return value;
}

function sameAssignment(left: ToolSandboxAssignment, right: ToolSandboxAssignment): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.executionLease === right.executionLease
  );
}

function handleMatches(
  handle: SandboxHandle,
  provider: SandboxProvider,
  activationId: string,
  assignment: ToolSandboxAssignment,
  environment: EnvironmentRuntimeSnapshot,
  workspaceRoot: string,
): boolean {
  return (
    handle.providerApiVersion === 1 &&
    handle.providerId === provider.providerId &&
    handle.activationId === activationId &&
    handle.workspaceRoot === workspaceRoot &&
    /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(handle.runtimeName) &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(handle.runtimeId) &&
    sameAssignment(handle.assignment, assignment) &&
    sameEnvironment(handle.environment, environment) &&
    handle.environmentValidation.profileKey === environment.profileKey &&
    handle.environmentValidation.profileVersion === environment.profileVersion &&
    handle.environmentValidation.imageRevision === environment.imageRevision &&
    handle.environmentValidation.specSha256 === environment.specSha256 &&
    handle.environmentValidation.recipeSha256 === environment.recipeSha256
  );
}

function samePhysicalRuntime(
  handle: SandboxHandle,
  assignment: SupervisorRuntimeAssignment,
): boolean {
  return (
    handle.runtimeId === assignment.containerId &&
    handle.runtimeName === assignment.containerName &&
    handle.assignment.workspaceId === assignment.workspaceId &&
    sameSupervisorAssignment(handle.assignment, assignment)
  );
}

function sameSupervisorAssignment(
  left: ToolSandboxAssignment,
  right: SupervisorRuntimeAssignment,
): boolean {
  return (
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.executionLease === right.executionLease
  );
}

function terminalAssignment(
  terminalId: string,
  input: Pick<WorkspaceTerminalOpenInput, "tenantId" | "projectId" | "workspaceId" | "sessionId">,
  executionLease: string,
): ToolSandboxAssignment {
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    supervisorId: "workspace-terminal",
    bootId: terminalId,
    sandboxId: terminalId,
    runId: terminalId,
    sessionId: input.sessionId,
    turnId: terminalId,
    executionLease,
  };
}

function developmentEnvironmentAssignment(
  input: Pick<
    DevelopmentEnvironmentProvisionRequest,
    "environmentId" | "tenantId" | "projectId" | "workspaceId" | "generation"
  >,
): ToolSandboxAssignment {
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    supervisorId: "development-environment",
    bootId: input.environmentId,
    sandboxId: input.environmentId,
    runId: input.environmentId,
    sessionId: input.environmentId,
    turnId: input.environmentId,
    executionLease: createExecutionLease(
      input.environmentId,
      input.environmentId,
      input.generation,
    ),
  };
}

export class ToolBroker {
  readonly #provider: SandboxProvider;
  readonly #ownerBaseUrl: string;
  readonly #stateRepository: WorkspaceRuntimeStateRepository;
  readonly #serviceRegistry: SandboxHttpServiceRegistry | undefined;
  readonly #idGenerator: () => string;
  readonly #maximumActiveSandboxes: number;
  readonly #warmTtlMs: number;
  readonly #maximumWarmWorkspaceRuntimes: number;
  readonly #clock: () => number;
  readonly #imageRevision: string;
  readonly #onMaintenanceError: ((error: unknown) => void) | undefined;
  readonly #toolBindings = new Map<string, ManagedToolBinding>();
  readonly #warm = new Map<string, ManagedElasticRuntime>();
  readonly #terminals = new Map<string, ManagedWorkspaceTerminal>();
  readonly #developmentEnvironments = new Map<string, ManagedDevelopmentEnvironment>();
  readonly #admitted = new Map<string, ToolSandboxAssignment>();
  readonly #workspaceRuntimeProvisioningTails = new Map<string, Promise<void>>();
  readonly #admissionWaiters: AdmissionWaiter[] = [];
  readonly #reaper: NodeJS.Timeout;
  #developmentEnvironmentRecovery: Promise<number> | undefined;

  constructor(options: ToolBrokerOptions) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#stateRepository = options.stateRepository;
    this.#serviceRegistry = options.serviceRegistry;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#maximumActiveSandboxes = positiveInteger(
      options.maximumActiveSandboxes ?? DEFAULT_MAXIMUM_ACTIVE_SANDBOXES,
      "maximumActiveSandboxes",
      1_000,
    );
    this.#warmTtlMs = positiveInteger(
      options.warmTtlMs ?? DEFAULT_WARM_TTL_MS,
      "warmTtlMs",
      24 * 60 * 60_000,
    );
    this.#maximumWarmWorkspaceRuntimes = positiveInteger(
      options.maximumWarmWorkspaceRuntimes ?? DEFAULT_MAXIMUM_WARM_WORKSPACE_RUNTIMES,
      "maximumWarmWorkspaceRuntimes",
      1_000,
    );
    this.#clock = options.clock ?? Date.now;
    this.#imageRevision = options.imageRevision;
    this.#onMaintenanceError = options.onMaintenanceError;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#imageRevision)) {
      throw new TypeError("Workspace runtime image revision is invalid");
    }
    this.#reaper = setInterval(
      () =>
        void Promise.all([
          this.reapWarm(),
          this.reapRetiredWarm(),
          this.recoverPersistentDevelopmentEnvironments(),
          this.#reapOrphanedWorkspaceRuntimes(),
          this.#reapUnboundWorkspaceRuntimes(),
          this.#reapOrphanedTerminals(),
          this.#reapOrphanedDevelopmentEnvironments(),
        ]).catch((error: unknown) => this.#onMaintenanceError?.(error)),
      30_000,
    );
    this.#reaper.unref();
  }

  get providerId(): string {
    return this.#provider.providerId;
  }

  get activeCount(): number {
    const runtimeIds = new Set<string>();
    for (const activation of this.#toolBindings.values()) {
      const handle = activation.elasticRuntime?.handle ?? activation.handle;
      if (handle !== undefined) runtimeIds.add(handle.runtimeId);
    }
    for (const runtime of this.#warm.values()) {
      if (runtime.handle !== undefined) runtimeIds.add(runtime.handle.runtimeId);
    }
    for (const terminal of this.#terminals.values()) runtimeIds.add(terminal.handle.runtimeId);
    for (const environment of this.#developmentEnvironments.values()) {
      runtimeIds.add(environment.handle.runtimeId);
    }
    return runtimeIds.size;
  }

  get admittedCount(): number {
    return this.#admitted.size;
  }

  get admissionWaitingCount(): number {
    return this.#admissionWaiters.length;
  }

  get maximumActiveSandboxes(): number {
    return this.#maximumActiveSandboxes;
  }

  get reservedCount(): number {
    return this.#toolBindings.size;
  }

  async recoverPersistentDevelopmentEnvironments(): Promise<number> {
    if (this.#developmentEnvironmentRecovery !== undefined) {
      return this.#developmentEnvironmentRecovery;
    }
    const recovery = this.#recoverPersistentDevelopmentEnvironments();
    this.#developmentEnvironmentRecovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.#developmentEnvironmentRecovery === recovery) {
        this.#developmentEnvironmentRecovery = undefined;
      }
    }
  }

  async #recoverPersistentDevelopmentEnvironments(): Promise<number> {
    if (this.#provider.adoptPersistentCapsule === undefined) return 0;
    const recoverable = await this.#stateRepository.claimRecoverableDevelopmentEnvironments(256, [
      ...this.#developmentEnvironments.keys(),
    ]);
    let recovered = 0;
    for (const candidate of recoverable) {
      let handle: SandboxHandle | undefined;
      try {
        handle = await this.#provider.adoptPersistentCapsule(candidate.runtimeCapsule);
        const expected = developmentEnvironmentAssignment({
          environmentId: candidate.reservation.environmentId,
          tenantId: candidate.reservation.tenantId,
          projectId: candidate.reservation.projectId,
          workspaceId: candidate.reservation.workspaceId,
          generation: candidate.reservation.generation,
        });
        if (
          handle.activationId !== candidate.reservation.environmentId ||
          !sameAssignment(handle.assignment, expected)
        ) {
          throw new ToolBrokerError(
            "persistent_machine_recovery_identity_mismatch",
            "Recovered exclusive machine identity did not match PostgreSQL",
            false,
          );
        }
        this.#developmentEnvironments.set(candidate.reservation.environmentId, {
          reservation: candidate.reservation,
          assignment: expected,
          handle,
          bindingIds: new Set(),
        });
        this.#admitted.set(candidate.reservation.environmentId, expected);
        const capsule = await this.#persistentCapsule(handle);
        if (capsule === undefined) {
          throw new ToolBrokerError(
            "persistent_machine_state_unsupported",
            "Recovered exclusive machine could not refresh its encrypted state",
            false,
          );
        }
        const inspection = await this.#provider.inspect(handle);
        const recoveredState =
          inspection.state === "stopped" || candidate.state === "paused" ? "paused" : "running";
        await this.#stateRepository.setDevelopmentEnvironmentState(
          candidate.reservation.environmentId,
          recoveredState,
          { handle, runtimeCapsule: capsule },
        );
        recovered += 1;
      } catch (error: unknown) {
        if (handle !== undefined) {
          await this.#provider.detachPersistent?.(handle).catch(() => undefined);
        }
        await this.#stateRepository
          .setDevelopmentEnvironmentState(candidate.reservation.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
            runtimeCapsule: candidate.runtimeCapsule,
          })
          .catch(() => undefined);
      }
    }
    return recovered;
  }

  get warmCount(): number {
    return this.#warm.size;
  }

  get cleanPrewarmCount(): number {
    return this.#provider.cleanPrewarmCount ?? 0;
  }

  async checkHealth(): Promise<void> {
    await Promise.all([this.#provider.checkHealth(), this.#stateRepository.checkHealth()]);
  }

  async provisionDevelopmentEnvironment(
    request: DevelopmentEnvironmentProvisionRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    if (
      this.#provider.openTerminal === undefined ||
      this.#provider.pause === undefined ||
      this.#provider.resume === undefined ||
      this.#provider.persistentCapsule === undefined ||
      this.#provider.adoptPersistentCapsule === undefined ||
      this.#provider.detachPersistent === undefined
    ) {
      throw new ToolBrokerError(
        "development_environment_unsupported",
        "The configured Sandbox Provider does not support development environments",
        false,
      );
    }
    const existing = this.#developmentEnvironments.get(request.environmentId);
    if (existing !== undefined) {
      if (
        existing.reservation.tenantId !== request.tenantId ||
        existing.reservation.userId !== request.userId ||
        existing.reservation.workspaceId !== request.workspaceId ||
        existing.reservation.generation !== request.generation ||
        existing.reservation.profileKey !== request.profileKey
      ) {
        throw new ToolBrokerError(
          "development_environment_identity_conflict",
          "Development environment identity was reused with different ownership",
          false,
        );
      }
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
        ...(existing.handle.ipAddress === undefined
          ? {}
          : { ipAddress: existing.handle.ipAddress }),
      };
    }
    const reservation: DevelopmentEnvironmentReservation = {
      environmentId: request.environmentId,
      tenantId: request.tenantId,
      userId: request.userId,
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      environmentVersionId: request.environment.environmentVersionId,
      generation: request.generation,
      profileKey: request.profileKey,
    };
    const reserved = await this.#stateRepository.reserveDevelopmentEnvironment(reservation);
    if (reserved.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reserved.ownerBaseUrl);
    }
    if (reserved.status === "busy") {
      throw new ToolBrokerError(
        "development_environment_workspace_busy",
        "Workspace is already owned by another execution environment",
        true,
      );
    }
    if (reserved.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    const assignment = developmentEnvironmentAssignment(request);
    let handle: SandboxHandle | undefined;
    let admitted = false;
    try {
      await this.#acquireAdmission(request.environmentId, assignment);
      admitted = true;
      handle = await this.#provider.create({
        activationId: request.environmentId,
        assignment,
        environment: request.environment,
        workspaceSeed: request.workspaceSeed,
        policy: this.#provider.defaultPolicy,
        toolRoot: DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
        lifetime: "development_environment",
        sandboxProfileKey: request.profileKey,
      });
      if (
        !handleMatches(
          handle,
          this.#provider,
          request.environmentId,
          assignment,
          request.environment,
          DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
        )
      ) {
        throw new ToolBrokerError(
          "sandbox_provider_protocol_error",
          "Sandbox Provider returned a mismatched development environment handle",
          false,
        );
      }
      this.#developmentEnvironments.set(request.environmentId, {
        reservation,
        assignment,
        handle,
        bindingIds: new Set(),
      });
      const runtimeCapsule = await this.#persistentCapsule(handle);
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "running", {
        handle,
        ...(runtimeCapsule === undefined ? {} : { runtimeCapsule }),
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
        ...(handle.ipAddress === undefined ? {} : { ipAddress: handle.ipAddress }),
      };
    } catch (error: unknown) {
      if (handle !== undefined) await this.#provider.destroy(handle).catch(() => undefined);
      if (admitted) this.#releaseAdmission(request.environmentId);
      await this.#stateRepository
        .setDevelopmentEnvironmentState(request.environmentId, "failed", {
          failureCode: operationFailureCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async developmentEnvironmentLifecycle(
    request: DevelopmentEnvironmentLifecycleRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    const ownership = await this.#stateRepository.developmentEnvironmentOwner(
      request.tenantId,
      request.userId,
      request.environmentId,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(request.environmentId);
    if (ownership.status === "owned" && environment === undefined && request.action === "release") {
      if (ownership.agentActive || ownership.terminalActive) {
        throw new ToolBrokerError(
          "development_environment_agent_active",
          "Wait for the active Agent Run or terminal before releasing the development environment",
          true,
        );
      }
      await this.#stateRepository.setDevelopmentEnvironmentState(
        request.environmentId,
        "releasing",
      );
      const assignment = developmentEnvironmentAssignment({
        environmentId: ownership.reservation.environmentId,
        tenantId: ownership.reservation.tenantId,
        projectId: ownership.reservation.projectId,
        workspaceId: ownership.reservation.workspaceId,
        generation: ownership.reservation.generation,
      });
      try {
        await this.#provider.destroyRuntime(request.environmentId, assignment);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
      this.#releaseAdmission(request.environmentId);
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "released");
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "released",
      };
    }
    if (ownership.status !== "owned" || environment === undefined) {
      throw new ToolBrokerError(
        "development_environment_unavailable",
        "Development environment is unavailable on its owning Tool Broker",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== request.tenantId ||
      environment.reservation.userId !== request.userId
    ) {
      throw new ToolBrokerError(
        "development_environment_unauthorized",
        "Development environment ownership did not match",
        false,
      );
    }
    if (environment.bindingIds.size > 0) {
      throw new ToolBrokerError(
        "development_environment_agent_active",
        "Wait for the active Agent Run before changing the development environment",
        true,
      );
    }
    if (request.action === "pause") {
      if (ownership.state !== "running" || environment.terminal !== undefined) {
        throw new ToolBrokerError(
          "development_environment_pause_conflict",
          "Close the active terminal before pausing the development environment",
          true,
        );
      }
      try {
        await this.#provider.pause!(environment.handle);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
      const runtimeCapsule = await this.#persistentCapsule(environment.handle);
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "paused", {
        handle: environment.handle,
        ...(runtimeCapsule === undefined ? {} : { runtimeCapsule }),
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "paused",
      };
    }
    if (request.action === "resume") {
      if (ownership.state !== "paused") {
        throw new ToolBrokerError(
          "development_environment_resume_conflict",
          "Development environment is not paused",
          false,
        );
      }
      try {
        environment.handle = await this.#provider.resume!(environment.handle);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
      const runtimeCapsule = await this.#persistentCapsule(environment.handle);
      await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "running", {
        handle: environment.handle,
        ...(runtimeCapsule === undefined ? {} : { runtimeCapsule }),
      });
      return {
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.state",
        requestId: request.requestId,
        environmentId: request.environmentId,
        state: "running",
      };
    }
    await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "releasing");
    environment.terminal?.disconnect();
    await environment.terminal?.kill().catch(() => undefined);
    try {
      await this.#provider.destroy(environment.handle);
      await this.#serviceRegistry?.endRuntime(environment.handle.runtimeId).catch(() => undefined);
    } catch (error: unknown) {
      await this.#stateRepository
        .setDevelopmentEnvironmentState(request.environmentId, "unknown", {
          failureCode: operationFailureCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
    this.#developmentEnvironments.delete(request.environmentId);
    this.#releaseAdmission(request.environmentId);
    await this.#stateRepository.setDevelopmentEnvironmentState(request.environmentId, "released");
    return {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.state",
      requestId: request.requestId,
      environmentId: request.environmentId,
      state: "released",
    };
  }

  async browseDevelopmentEnvironment(
    request:
      | Extract<DevelopmentEnvironmentBrokerRequest, { type: "development_environment.directory" }>
      | Extract<
          DevelopmentEnvironmentBrokerRequest,
          { type: "development_environment.create_directory" }
        >,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    if (
      (request.type === "development_environment.directory" &&
        this.#provider.listDirectory === undefined) ||
      (request.type === "development_environment.create_directory" &&
        this.#provider.createDirectory === undefined)
    ) {
      throw new ToolBrokerError(
        "development_environment_directory_unsupported",
        "Sandbox Provider cannot manage an exclusive machine filesystem",
        false,
      );
    }
    const ownership = await this.#stateRepository.developmentEnvironmentOwner(
      request.tenantId,
      request.userId,
      request.environmentId,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(request.environmentId);
    if (
      ownership.status !== "owned" ||
      ownership.state !== "running" ||
      environment === undefined
    ) {
      throw new ToolBrokerError(
        "development_environment_directory_unavailable",
        "Exclusive machine is not running on its owning Tool Broker",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== request.tenantId ||
      environment.reservation.userId !== request.userId
    ) {
      throw new ToolBrokerError(
        "development_environment_unauthorized",
        "Exclusive machine ownership did not match",
        false,
      );
    }
    const directory =
      request.type === "development_environment.create_directory"
        ? await this.#provider.createDirectory!(environment.handle, request.path, request.name)
        : await this.#provider.listDirectory!(environment.handle, request.path);
    return {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.directory",
      requestId: request.requestId,
      environmentId: request.environmentId,
      path: directory.path,
      entries: [...directory.entries],
    };
  }

  async openDevelopmentEnvironmentTerminal(
    input: DevelopmentEnvironmentTerminalOpenRequest,
  ): Promise<WorkspaceTerminalConnection> {
    if (this.#provider.openTerminal === undefined) {
      throw new ToolBrokerError(
        "development_environment_terminal_unsupported",
        "The configured Sandbox Provider does not support interactive terminals",
        false,
      );
    }
    const ownership = await this.#stateRepository.developmentEnvironmentOwner(
      input.tenantId,
      input.userId,
      input.environmentId,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(input.environmentId);
    if (
      ownership.status !== "owned" ||
      ownership.state !== "running" ||
      environment === undefined
    ) {
      throw new ToolBrokerError(
        "development_environment_terminal_unavailable",
        "Development environment must be running before opening a terminal",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== input.tenantId ||
      environment.reservation.userId !== input.userId
    ) {
      throw new ToolBrokerError(
        "development_environment_unauthorized",
        "Development environment ownership did not match",
        false,
      );
    }
    if (environment.terminal !== undefined) {
      throw new ToolBrokerError(
        "development_environment_terminal_busy",
        "Development environment already has an active terminal",
        true,
      );
    }
    if (!(await this.#stateRepository.reserveDevelopmentEnvironmentTerminal(input.environmentId))) {
      throw new ToolBrokerError(
        "development_environment_terminal_busy",
        "Development environment already has an active terminal",
        true,
      );
    }
    const terminalHandle = environment.handle;
    let terminal: SandboxTerminalSession;
    try {
      terminal = await this.#provider.openTerminal(terminalHandle, {
        rows: input.rows,
        cols: input.cols,
      });
    } catch (error: unknown) {
      await this.#stateRepository
        .releaseDevelopmentEnvironmentTerminal(input.environmentId)
        .catch(() => undefined);
      throw error;
    }
    environment.terminal = terminal;
    let closed = false;
    return Object.freeze({
      terminalId: input.environmentId,
      pid: terminal.pid,
      workspaceRoot: terminalHandle.workspaceRoot,
      output: terminal.output,
      sendInput: (data: Uint8Array) => terminal.sendInput(data),
      resize: (size: SandboxTerminalSize) => terminal.resize(size),
      close: async () => {
        if (closed) return;
        closed = true;
        terminal.disconnect();
        await terminal.kill().catch(() => undefined);
        if (environment.terminal === terminal) delete environment.terminal;
        await this.#stateRepository
          .releaseDevelopmentEnvironmentTerminal(input.environmentId)
          .catch(() => undefined);
      },
    });
  }

  async openTerminal(input: WorkspaceTerminalOpenInput): Promise<WorkspaceTerminalConnection> {
    if (this.#provider.openTerminal === undefined) {
      throw new ToolBrokerError(
        "workspace_terminal_unsupported",
        "The configured Sandbox Provider does not support interactive terminals",
        false,
      );
    }
    if (
      input.environment.profileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      input.environment.profileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      input.environment.specSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      input.environment.imageRevision !== this.#imageRevision ||
      createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(input.environment.recipe))
        .digest("hex") !== input.environment.recipeSha256
    ) {
      throw new ToolBrokerError(
        "environment_policy_mismatch",
        "Workspace environment is not served by this Tool Broker",
        false,
      );
    }
    const terminalId = validActivationId(this.#idGenerator());
    const reservation = await this.#stateRepository.reserveTerminal({
      terminalId,
      tenantId: input.tenantId,
      userId: input.userId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (reservation.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new ToolBrokerError(
        "workspace_terminal_busy",
        "Workspace already has an active human terminal",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    const assignment = terminalAssignment(terminalId, input, reservation.executionLease);
    let admitted = false;
    let handle: SandboxHandle | undefined;
    let terminal: SandboxTerminalSession | undefined;
    let workspaceRuntime: ManagedElasticRuntime | undefined;
    try {
      workspaceRuntime =
        reservation.workspaceRuntimeId === undefined
          ? undefined
          : ([...this.#toolBindings.values()].find(
              (activation) =>
                activation.elasticRuntime?.physicalActivationId === reservation.workspaceRuntimeId,
            )?.elasticRuntime ??
            [...this.#warm.values()].find(
              (runtime) => runtime.physicalActivationId === reservation.workspaceRuntimeId,
            ));
      if (reservation.workspaceRuntimeId !== undefined && workspaceRuntime === undefined) {
        throw new ToolBrokerError(
          "workspace_runtime_unavailable",
          "Workspace runtime is not attached to its owning Tool Broker",
          true,
        );
      }
      await this.#stateRepository.setTerminalState(terminalId, "materializing");
      if (workspaceRuntime === undefined) {
        await this.#acquireAdmission(terminalId, assignment);
        admitted = true;
        handle = await this.#provider.create({
          activationId: terminalId,
          assignment,
          environment: input.environment,
          workspaceSeed: input.workspaceSeed,
          policy: this.#provider.defaultPolicy,
          toolRoot: "/workspace",
        });
      } else {
        this.#warm.delete(workspaceRuntime.workspaceKey);
        handle = await this.#materializeElasticRuntime(workspaceRuntime);
        workspaceRuntime.workspaceTerminalId = terminalId;
        await this.#stateRepository.setWorkspaceRuntimeState(
          workspaceRuntime.physicalActivationId,
          "active",
          { handle },
        );
      }
      if (handle === undefined) {
        throw new ToolBrokerError(
          "workspace_terminal_runtime_unavailable",
          "Workspace terminal runtime was unavailable",
          true,
        );
      }
      terminal = await this.#provider.openTerminal(handle, input.size);
      const activeTerminal = terminal;
      const managed: ManagedWorkspaceTerminal = {
        assignment,
        handle,
        session: activeTerminal,
        ...(workspaceRuntime === undefined ? {} : { workspaceRuntime }),
      };
      await this.#stateRepository.setTerminalState(terminalId, "active", { handle });
      this.#terminals.set(terminalId, managed);
      return Object.freeze({
        terminalId,
        pid: activeTerminal.pid,
        workspaceRoot: handle.workspaceRoot,
        output: activeTerminal.output,
        sendInput: async (data: Uint8Array) => {
          this.#stateRepository.assertLocalOwnership();
          await activeTerminal.sendInput(data);
        },
        resize: async (size: SandboxTerminalSize) => {
          this.#stateRepository.assertLocalOwnership();
          await activeTerminal.resize(size);
        },
        close: () => this.#closeTerminal(terminalId, managed),
      });
    } catch (error: unknown) {
      this.#terminals.delete(terminalId);
      terminal?.disconnect();
      await terminal?.kill().catch(() => undefined);
      if (workspaceRuntime !== undefined) {
        delete workspaceRuntime.workspaceTerminalId;
        if (workspaceRuntime.bindingIds.size === 0 && workspaceRuntime.handle !== undefined) {
          const now = this.#now();
          workspaceRuntime.lastUsedAt = now;
          workspaceRuntime.expiresAt = now + this.#warmTtlMs;
          this.#warm.set(workspaceRuntime.workspaceKey, workspaceRuntime);
        }
      } else if (handle !== undefined) {
        await this.#provider.destroy(handle).catch(() => undefined);
      }
      if (admitted) this.#releaseAdmission(terminalId);
      await this.#stateRepository
        .setTerminalState(terminalId, "unknown", { failureCode: operationFailureCode(error) })
        .catch(() => undefined);
      throw error;
    }
  }

  async preview(request: SandboxPreviewRequest): Promise<SandboxPreviewResponse> {
    if (this.#provider.previewHttp === undefined) {
      throw new ToolBrokerError(
        "sandbox_preview_unsupported",
        "The configured Sandbox Provider does not support HTTP preview",
        false,
      );
    }
    const ownership = await this.#stateRepository.sandboxPreviewOwner(
      request.tenantId,
      request.userId,
      request.target,
    );
    if (ownership.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(ownership.ownerBaseUrl);
    }
    if (ownership.status === "unavailable") {
      throw new ToolBrokerError(
        "sandbox_preview_unavailable",
        "Sandbox preview target is not running",
        true,
      );
    }
    let handle: SandboxHandle | undefined;
    if (request.target.kind === "development_environment") {
      handle = this.#developmentEnvironments.get(request.target.environmentId)?.handle;
    } else {
      const sessionId = request.target.sessionId;
      const runtimeId = ownership.runtimeId;
      handle = [...this.#toolBindings.values()].find(
        (candidate) => candidate.elasticRuntime?.handle?.runtimeId === runtimeId,
      )?.elasticRuntime?.handle;
      handle ??= [...this.#warm.values()].find(
        (candidate) => candidate.handle?.runtimeId === runtimeId,
      )?.handle;
      handle ??= [...this.#terminals.values()].find(
        (candidate) => candidate.handle.runtimeId === runtimeId,
      )?.handle;
      if (handle === undefined && runtimeId === undefined) {
        handle = [...this.#toolBindings.values()].find(
          (candidate) => candidate.assignment.sessionId === sessionId,
        )?.elasticRuntime?.handle;
        handle ??= [...this.#warm.values()].find(
          (candidate) => candidate.spec.assignment.sessionId === sessionId,
        )?.handle;
      }
    }
    if (handle === undefined) {
      throw new ToolBrokerError(
        "sandbox_preview_unavailable",
        "Sandbox preview target has no live runtime",
        true,
      );
    }
    let body: Buffer | undefined;
    if (request.body !== undefined) {
      body = Buffer.from(request.body, "base64");
      if (body.toString("base64") !== request.body) {
        throw new ToolBrokerError(
          "sandbox_preview_request_invalid",
          "Sandbox preview body was invalid",
          false,
        );
      }
    }
    const response = await this.#provider.previewHttp(handle, {
      port: request.port,
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(body === undefined ? {} : { body }),
    });
    return {
      sandboxPreviewProtocolVersion: 1,
      type: "sandbox_preview.response",
      requestId: request.requestId,
      status: response.status,
      headers: response.headers,
      body: Buffer.from(response.body).toString("base64"),
    };
  }

  async create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse> {
    this.#assertCreateEnvironment(request);
    return request.executionMode === "elastic"
      ? this.#serializeWorkspaceRuntimeProvisioning(request.assignment, () =>
          this.#createElasticBinding(request),
        )
      : this.#createDevelopmentEnvironmentBinding(request);
  }

  #assertCreateEnvironment(request: ToolSandboxCreateRequest): void {
    if (
      request.environment.profileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
      request.environment.profileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
      request.environment.specSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
      request.environment.imageRevision !== this.#imageRevision ||
      createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(request.environment.recipe))
        .digest("hex") !== request.environment.recipeSha256
    ) {
      throw new ToolBrokerError(
        "environment_policy_mismatch",
        "Run environment is not served by this Tool Broker",
        false,
      );
    }
  }

  async #createElasticBinding(
    request: ToolSandboxCreateRequest,
  ): Promise<ToolSandboxCreateResponse> {
    const workspaceKey = workspaceIdentityKey(request.assignment);
    if (
      [...this.#developmentEnvironments.values()].some(
        (environment) =>
          environment.reservation.tenantId === request.assignment.tenantId &&
          environment.reservation.workspaceId === request.assignment.workspaceId,
      )
    ) {
      throw new ToolBrokerError(
        "development_environment_execution_mode_mismatch",
        "Machine-owned Workspace requires development-environment execution mode",
        false,
      );
    }
    let runtime = [...this.#toolBindings.values()].find(
      (activation) => activation.elasticRuntime?.workspaceKey === workspaceKey,
    )?.elasticRuntime;
    runtime ??= this.#warm.get(workspaceKey);
    const workspaceTerminal = [...this.#terminals.entries()].find(
      ([, terminal]) =>
        terminal.assignment.tenantId === request.assignment.tenantId &&
        terminal.assignment.projectId === request.assignment.projectId &&
        terminal.assignment.workspaceId === request.assignment.workspaceId,
    );
    runtime ??= workspaceTerminal?.[1].workspaceRuntime;
    if (
      runtime !== undefined &&
      (!sameEnvironment(runtime.environment, request.environment) ||
        runtime.sandboxProfileKey !== request.sandboxProfileKey)
    ) {
      if (runtime.bindingIds.size > 0) {
        throw new ToolBrokerError(
          "workspace_runtime_profile_conflict",
          "Workspace already has an active Cube with a different environment profile",
          true,
        );
      }
      await this.#discardWarm(workspaceKey, runtime);
      runtime = undefined;
    }
    if (runtime !== undefined) this.#warm.delete(workspaceKey);
    if (runtime === undefined) {
      const physicalActivationId = validActivationId(workspaceTerminal?.[0] ?? this.#idGenerator());
      runtime = {
        physicalActivationId,
        workspaceKey,
        spec: {
          activationId: physicalActivationId,
          assignment: request.assignment,
          environment: request.environment,
          workspaceSeed: request.workspaceSeed,
          ...(request.workspaceSettlement === undefined
            ? {}
            : { workspaceSettlement: request.workspaceSettlement }),
          policy: this.#provider.defaultPolicy,
          toolRoot: request.toolRoot,
          sandboxProfileKey: request.sandboxProfileKey,
        },
        ...(workspaceTerminal === undefined ? {} : { handle: workspaceTerminal[1].handle }),
        bindingIds: new Set(),
        initialBindingIssued: false,
        activeOperations: 0,
        exclusiveOperation: false,
        workspaceRevision: request.workspaceRevision ?? "0".repeat(64),
        environment: request.environment,
        sandboxProfileKey: request.sandboxProfileKey,
        expiresAt: Number.POSITIVE_INFINITY,
        lastUsedAt: this.#now(),
        ...(workspaceTerminal === undefined ? {} : { workspaceTerminalId: workspaceTerminal[0] }),
      };
      if (workspaceTerminal !== undefined) workspaceTerminal[1].workspaceRuntime = runtime;
    }

    const activationId = validActivationId(
      runtime.initialBindingIssued
        ? parseExecutionLease(request.assignment.executionLease).attemptId
        : runtime.physicalActivationId,
    );
    if (this.#toolBindings.has(activationId) || runtime.bindingIds.has(activationId)) {
      throw new ToolBrokerError(
        "tool_binding_identity_collision",
        "Tool binding identity collided",
        false,
      );
    }
    const allowedTools = parseCloudToolCapabilitySnapshot(request.allowedTools);
    const reservationInput: WorkspaceRuntimeReservation = {
      activationId: runtime.physicalActivationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      environmentSha256: createHash("sha256")
        .update(
          JSON.stringify({
            environmentVersionId: request.environment.environmentVersionId,
            specSha256: request.environment.specSha256,
            recipeSha256: request.environment.recipeSha256,
            sandboxProfileKey: request.sandboxProfileKey,
          }),
        )
        .digest("hex"),
      ...(request.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: request.workspaceRevision }),
    };
    const reservation = await this.#stateRepository.reserve(reservationInput);
    if (reservation.status === "redirect") {
      throw new ToolBrokerOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new ToolBrokerError(
        "workspace_runtime_busy",
        "Workspace runtime is temporarily unavailable",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new ToolBrokerError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    if (reservation.status === "development_environment") {
      throw new ToolBrokerError(
        "elastic_execution_mode_mismatch",
        "Elastic Workspace unexpectedly resolved to a development environment",
        false,
      );
    }
    runtime.bindingIds.add(activationId);
    runtime.initialBindingIssued = true;
    this.#toolBindings.set(activationId, {
      activationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      allowedTools: new Set(allowedTools),
      spec: { ...runtime.spec, assignment: request.assignment },
      reservation: reservationInput,
      elasticRuntime: runtime,
      usedPhysicalRuntime: false,
      activeOperations: 0,
      exclusiveOperation: false,
      operations: new Map(),
      seenCaptureIds: new Set(),
    });
    if (runtime.handle !== undefined) {
      await this.#stateRepository.setWorkspaceRuntimeState(runtime.physicalActivationId, "active", {
        handle: runtime.handle,
      });
    }
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      executionLease: request.assignment.executionLease,
      ownerBaseUrl: this.#ownerBaseUrl,
      workspaceRoot: request.toolRoot,
      continuity: runtime.handle === undefined ? "cold_restore" : "warm_reuse",
      continuityId: runtime.handle?.runtimeId ?? runtime.physicalActivationId,
    };
  }

  async #createDevelopmentEnvironmentBinding(
    request: ToolSandboxCreateRequest,
  ): Promise<ToolSandboxCreateResponse> {
    const environment = [...this.#developmentEnvironments.values()].find(
      (candidate) =>
        candidate.reservation.tenantId === request.assignment.tenantId &&
        candidate.reservation.workspaceId === request.assignment.workspaceId,
    );
    if (environment === undefined) {
      throw new ToolBrokerError(
        "elastic_execution_mode_mismatch",
        "Development-environment execution requires an owned machine",
        false,
      );
    }
    if (environment.reservation.profileKey !== request.sandboxProfileKey) {
      throw new ToolBrokerError(
        "development_environment_profile_mismatch",
        "Conversation Sandbox profile does not match its exclusive environment",
        false,
      );
    }
    const physicalActivationId = validActivationId(environment.reservation.environmentId);
    const activationId = validActivationId(
      environment.bindingIds.size === 0
        ? physicalActivationId
        : parseExecutionLease(request.assignment.executionLease).attemptId,
    );
    if (this.#toolBindings.has(activationId) || environment.bindingIds.has(activationId)) {
      throw new ToolBrokerError(
        "tool_binding_identity_collision",
        "Tool binding identity collided",
        false,
      );
    }
    const reservationInput: WorkspaceRuntimeReservation = {
      activationId: physicalActivationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      environmentSha256: createHash("sha256")
        .update(
          JSON.stringify({
            environmentVersionId: request.environment.environmentVersionId,
            specSha256: request.environment.specSha256,
            recipeSha256: request.environment.recipeSha256,
            sandboxProfileKey: request.sandboxProfileKey,
          }),
        )
        .digest("hex"),
      ...(request.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: request.workspaceRevision }),
    };
    const reservation = await this.#stateRepository.reserve(reservationInput);
    if (reservation.status === "redirect")
      throw new ToolBrokerOwnerRedirectError(reservation.ownerBaseUrl);
    if (
      reservation.status !== "development_environment" ||
      reservation.environmentId !== environment.reservation.environmentId
    ) {
      throw new ToolBrokerError(
        "development_environment_workspace_busy",
        "Development environment could not grant Agent Tool authority",
        true,
      );
    }
    environment.bindingIds.add(activationId);
    this.#toolBindings.set(activationId, {
      activationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      attemptContextSha256: request.attemptContextSha256,
      allowedTools: new Set(parseCloudToolCapabilitySnapshot(request.allowedTools)),
      spec: {
        activationId: physicalActivationId,
        assignment: request.assignment,
        environment: request.environment,
        workspaceSeed: request.workspaceSeed,
        ...(request.workspaceSettlement === undefined
          ? {}
          : { workspaceSettlement: request.workspaceSettlement }),
        policy: this.#provider.defaultPolicy,
        toolRoot: request.toolRoot,
        sandboxProfileKey: request.sandboxProfileKey,
      },
      reservation: reservationInput,
      handle: environment.handle,
      usedPhysicalRuntime: false,
      activeOperations: 0,
      exclusiveOperation: false,
      operations: new Map(),
      seenCaptureIds: new Set(),
      developmentEnvironmentId: environment.reservation.environmentId,
    });
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      executionLease: request.assignment.executionLease,
      ownerBaseUrl: this.#ownerBaseUrl,
      workspaceRoot: request.toolRoot,
      continuity: "warm_reuse",
      continuityId: environment.handle.runtimeId,
    };
  }

  async execute(
    executionLease: string,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = this.#authorizedBinding(request.activationId, executionLease);
    const elasticRuntime = activation.elasticRuntime;
    if (activation.exclusiveOperation || elasticRuntime?.exclusiveOperation) {
      throw new ToolBrokerError(
        "workspace_runtime_busy",
        "Workspace is establishing an isolated Subagent fork",
        true,
      );
    }
    if (!activation.allowedTools.has(request.toolName)) {
      throw new ToolBrokerError(
        "tool_not_granted",
        "Tool is not present in this Run capability snapshot",
        false,
      );
    }
    if (!TOOL_OPERATIONS[request.toolName].has(request.operation)) {
      throw new ToolBrokerError(
        "tool_operation_not_granted",
        "Tool operation does not match its granted Tool",
        false,
      );
    }
    if (request.turnContextSha256 !== activation.turnContextSha256) {
      throw new ToolBrokerError(
        "turn_context_mismatch",
        "Tool operation did not match the frozen Cloud Turn context",
        false,
      );
    }
    if (request.attemptContextSha256 !== activation.attemptContextSha256) {
      throw new ToolBrokerError(
        "attempt_context_mismatch",
        "Tool operation did not match the current Cloud Attempt context",
        false,
      );
    }
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
    const existing = activation.operations.get(request.operationId);
    if (existing !== undefined) {
      if (existing.requestSha256 === requestSha256) return existing.result;
      throw new ToolBrokerError(
        "tool_operation_identity_conflict",
        "Tool operation ID was reused for a different request",
        false,
      );
    }
    const currentStep = activation.currentStep;
    if (currentStep === undefined || request.stepContextSequence > currentStep.sequence) {
      activation.currentStep = {
        sequence: request.stepContextSequence,
        sha256: request.stepContextSha256,
      };
    } else if (
      request.stepContextSequence < currentStep.sequence ||
      request.stepContextSha256 !== currentStep.sha256
    ) {
      throw new ToolBrokerError(
        "step_context_mismatch",
        "Tool operation used a stale or conflicting Cloud Step",
        false,
      );
    }
    const operationController = new AbortController();
    const operationSignal =
      signal === undefined
        ? operationController.signal
        : AbortSignal.any([signal, operationController.signal]);
    const durable = (async (): Promise<ToolSandboxOperationResponse> => {
      activation.activeOperations += 1;
      if (elasticRuntime !== undefined) elasticRuntime.activeOperations += 1;
      try {
        const started = await this.#stateRepository.beginOperation(
          elasticRuntime?.physicalActivationId ?? activation.reservation.activationId,
          request.activationId,
          activation.assignment,
          request.operationId,
          requestSha256,
        );
        if (started !== "started") {
          throw new ToolBrokerError(
            "tool_operation_outcome_unknown",
            "Tool operation may already have produced side effects",
            false,
          );
        }
        const handle = await this.#materialize(activation, operationSignal);
        let response: ToolSandboxOperationResponse;
        try {
          response = await this.#provider.exec(
            handle,
            request,
            operationSignal,
            activation.spec.toolRoot,
          );
        } catch (error: unknown) {
          if (elasticRuntime !== undefined) {
            await this.#markElasticRuntimeLost(elasticRuntime, error);
          }
          throw error;
        }
        if (
          request.operation === "bash.exec" &&
          this.#provider.discoverHttpServices !== undefined
        ) {
          const discovery = await this.#provider
            .discoverHttpServices(handle, operationSignal)
            .catch(() => undefined);
          if (discovery !== undefined) {
            await this.#observeHttpServices(
              activation,
              handle,
              request.operationId,
              discovery,
            ).catch(() => undefined);
          }
        }
        await this.#stateRepository.settleOperation(request.operationId, "succeeded");
        return response;
      } catch (error: unknown) {
        await this.#stateRepository
          .settleOperation(
            request.operationId,
            operationSignal.aborted ? "cancelled" : "failed",
            operationFailureCode(error),
          )
          .catch(() => undefined);
        throw error;
      } finally {
        activation.activeOperations -= 1;
        if (elasticRuntime !== undefined) elasticRuntime.activeOperations -= 1;
      }
    })();
    activation.operations.set(request.operationId, {
      requestSha256,
      result: durable,
      controller: operationController,
    });
    return durable;
  }

  async capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
    requestId: string,
  ): Promise<ToolSandboxCaptureResponse> {
    const activation = this.#ownedBinding(activationId, assignment);
    if (activation.seenCaptureIds.has(requestId)) {
      throw new ToolBrokerError(
        "tool_capture_replay",
        "Tool binding settlement ID was already used",
        false,
      );
    }
    activation.seenCaptureIds.add(requestId);
    if (!activation.usedPhysicalRuntime) {
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.unused",
        requestId,
        activationId,
      };
    }
    return this.#provider.settle(await this.#materialize(activation), requestId, {
      activationId,
      assignment,
    });
  }

  async forkWorkspace(
    request: ToolBrokerWorkspaceForkRequest,
  ): Promise<ToolBrokerWorkspaceForkResponse> {
    if (this.#provider.forkWorkspace === undefined) {
      throw new ToolBrokerError(
        "workspace_fork_unsupported",
        "The configured Sandbox Provider cannot create isolated Workspace forks",
        false,
      );
    }
    const activation = this.#ownedBinding(request.sourceActivationId, request.sourceAssignment);
    const elasticRuntime = activation.elasticRuntime;
    if (
      activation.exclusiveOperation ||
      activation.activeOperations !== 0 ||
      activation.materializing !== undefined ||
      elasticRuntime?.exclusiveOperation ||
      (elasticRuntime?.activeOperations ?? 0) !== 0 ||
      elasticRuntime?.materializing !== undefined
    ) {
      throw new ToolBrokerError(
        "workspace_runtime_busy",
        "Parent Workspace is busy and cannot be isolated",
        true,
      );
    }
    activation.exclusiveOperation = true;
    if (elasticRuntime !== undefined) elasticRuntime.exclusiveOperation = true;
    try {
      const handle = await this.#materialize(activation);
      const forked = await this.#provider.forkWorkspace(handle, request);
      if (elasticRuntime === undefined) activation.handle = forked.sourceHandle;
      else elasticRuntime.handle = forked.sourceHandle;
      activation.usedPhysicalRuntime = true;
      return {
        toolBrokerProtocolVersion: 1,
        type: "workspace.forked",
        requestId: request.requestId,
        sourceActivationId: request.sourceActivationId,
        targetWorkspaceId: request.target.workspaceId,
        sourceSettlementRevision: forked.sourceSettlementRevision,
        targetSettlementRevision: forked.targetSettlementRevision,
      };
    } finally {
      activation.exclusiveOperation = false;
      if (elasticRuntime !== undefined) elasticRuntime.exclusiveOperation = false;
    }
  }

  async release(request: ToolSandboxReleaseRequest): Promise<ToolSandboxReleaseResponse> {
    return this.#releaseActivation(request);
  }

  async #releaseActivation(
    request: ToolSandboxReleaseRequest,
  ): Promise<ToolSandboxReleaseResponse> {
    const activation = this.#ownedBinding(request.activationId, request.assignment);
    if (activation.elasticRuntime !== undefined) {
      if (request.disposition === "detach") {
        throw new ToolBrokerError(
          "tool_binding_identity_mismatch",
          "Elastic Tool Sandbox bindings cannot detach from their runtime",
          false,
        );
      }
      return this.#releaseElasticBinding(request, activation);
    }
    if (request.disposition !== "detach") {
      throw new ToolBrokerError(
        "tool_binding_identity_mismatch",
        "Development environment Tool bindings must detach from their machine",
        false,
      );
    }
    let handle = activation.handle;
    if (activation.materializing !== undefined) {
      handle = await activation.materializing.catch(() => undefined);
    }
    this.#revokeBinding(request.activationId);
    const environmentId = activation.developmentEnvironmentId;
    const environment =
      environmentId === undefined ? undefined : this.#developmentEnvironments.get(environmentId);
    if (environment === undefined || !environment.bindingIds.has(request.activationId)) {
      throw new ToolBrokerError(
        "development_environment_identity_conflict",
        "Development environment Agent binding was lost",
        false,
      );
    }
    environment.bindingIds.delete(request.activationId);
    if (environment.bindingIds.size > 0) {
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: handle !== undefined,
      };
    }
    await this.#returnDevelopmentEnvironmentBinding(activation, environment, handle);
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.released",
      requestId: request.requestId,
      activationId: request.activationId,
      retained: true,
    };
  }

  async #releaseElasticBinding(
    request: ToolSandboxReleaseRequest,
    activation: ManagedToolBinding,
  ): Promise<ToolSandboxReleaseResponse> {
    const runtime = activation.elasticRuntime!;
    if (runtime.materializing !== undefined) {
      await runtime.materializing.catch(() => undefined);
    }
    this.#revokeBinding(request.activationId);
    runtime.bindingIds.delete(request.activationId);
    if ("workspaceRevision" in request) runtime.workspaceRevision = request.workspaceRevision;
    runtime.lastUsedAt = this.#now();
    if (runtime.bindingIds.size > 0) {
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: runtime.handle !== undefined,
      };
    }

    if (runtime.workspaceTerminalId !== undefined) {
      const terminal = this.#terminals.get(runtime.workspaceTerminalId);
      if (terminal !== undefined && runtime.handle !== undefined) terminal.handle = runtime.handle;
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: runtime.handle !== undefined,
      };
    }

    if (request.disposition !== "destroy" && runtime.handle !== undefined) {
      const now = this.#now();
      runtime.lastUsedAt = now;
      runtime.expiresAt = now + this.#warmTtlMs;
      this.#warm.set(runtime.workspaceKey, runtime);
      await this.#stateRepository.setWorkspaceRuntimeState(runtime.physicalActivationId, "warm", {
        handle: runtime.handle,
        workspaceRevision: runtime.workspaceRevision,
      });
      await this.#enforceWarmLimit();
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: true,
      };
    }

    if (runtime.handle !== undefined) {
      await this.#provider.stop(runtime.handle);
      await this.#serviceRegistry?.endRuntime(runtime.handle.runtimeId).catch(() => undefined);
    }
    this.#releaseAdmission(runtime.physicalActivationId);
    await this.#stateRepository.setWorkspaceRuntimeState(runtime.physicalActivationId, "released");
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.released",
      requestId: request.requestId,
      activationId: request.activationId,
      retained: false,
    };
  }

  async inspect(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<SandboxInspection> {
    const activation = this.#ownedBinding(activationId, assignment);
    return this.#provider.inspect(await this.#materialize(activation));
  }

  async stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    await this.#stopActivation(activationId, assignment);
  }

  async #stopActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#toolBindings.get(activationId);
    if (activation === undefined) {
      if (this.#admitted.has(activationId)) {
        await this.#provider.destroyRuntime(activationId, assignment);
        this.#releaseAdmission(activationId);
        await this.#stateRepository
          .setWorkspaceRuntimeState(activationId, "released")
          .catch(() => undefined);
      }
      return;
    }
    if (!sameAssignment(activation.assignment, assignment)) {
      throw new ToolBrokerError(
        "tool_binding_identity_mismatch",
        "Tool binding assignment identity did not match",
        false,
      );
    }
    if (activation.elasticRuntime !== undefined) {
      await this.#stopElasticBinding(activationId, activation);
      return;
    }
    if (activation.developmentEnvironmentId !== undefined) {
      const environment = this.#developmentEnvironments.get(activation.developmentEnvironmentId);
      const operations = [...activation.operations.values()];
      for (const operation of operations) operation.controller.abort();
      await Promise.allSettled(operations.map((operation) => operation.result));
      const handle =
        activation.materializing === undefined
          ? activation.handle
          : await activation.materializing.catch(() => undefined);
      this.#toolBindings.delete(activationId);
      environment?.bindingIds.delete(activationId);
      if (environment !== undefined && environment.bindingIds.size > 0) return;
      if (environment !== undefined) {
        await this.#returnDevelopmentEnvironmentBinding(activation, environment, handle);
      }
      return;
    }
    throw new ToolBrokerError(
      "tool_binding_identity_invalid",
      "Tool binding was not attached to a Workspace runtime or development environment",
      false,
    );
  }

  async #returnDevelopmentEnvironmentBinding(
    activation: ManagedToolBinding,
    environment: ManagedDevelopmentEnvironment,
    handle: SandboxHandle | undefined,
  ): Promise<void> {
    if (handle !== undefined) environment.handle = handle;
    try {
      const runtimeCapsule = await this.#persistentCapsule(environment.handle);
      if (runtimeCapsule === undefined) {
        throw new ToolBrokerError(
          "persistent_machine_recovery_state_unavailable",
          "Development environment recovery state was unavailable after Agent execution",
          true,
        );
      }
      await this.#stateRepository.returnDevelopmentEnvironment(
        environment.reservation.environmentId,
        activation.reservation.activationId,
        "running",
        { handle: environment.handle, runtimeCapsule },
      );
    } catch (error: unknown) {
      await this.#stateRepository
        .returnDevelopmentEnvironment(
          environment.reservation.environmentId,
          activation.reservation.activationId,
          "unknown",
          { handle: environment.handle, failureCode: operationFailureCode(error) },
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async #stopElasticBinding(activationId: string, activation: ManagedToolBinding): Promise<void> {
    const runtime = activation.elasticRuntime!;
    if (runtime.materializing !== undefined) await runtime.materializing.catch(() => undefined);
    const operations = [...activation.operations.values()];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map((operation) => operation.result));
    this.#revokeBinding(activationId);
    runtime.bindingIds.delete(activationId);
    if (runtime.bindingIds.size > 0) return;
    if (runtime.workspaceTerminalId !== undefined) {
      const terminal = this.#terminals.get(runtime.workspaceTerminalId);
      if (terminal !== undefined && runtime.handle !== undefined) terminal.handle = runtime.handle;
      return;
    }
    if (runtime.handle !== undefined) {
      await this.#provider.stop(runtime.handle);
      await this.#serviceRegistry?.endRuntime(runtime.handle.runtimeId).catch(() => undefined);
    }
    this.#releaseAdmission(runtime.physicalActivationId);
    await this.#stateRepository.setWorkspaceRuntimeState(runtime.physicalActivationId, "released");
  }

  #httpServiceTarget(activation: ManagedToolBinding): SandboxHttpServiceTarget {
    return activation.developmentEnvironmentId === undefined
      ? this.#conversationHttpServiceTarget(activation.assignment)
      : {
          kind: "development_environment",
          targetId: activation.developmentEnvironmentId,
          tenantId: activation.assignment.tenantId,
          workspaceId: activation.assignment.workspaceId,
          sessionId: activation.assignment.sessionId,
          developmentEnvironmentId: activation.developmentEnvironmentId,
        };
  }

  #conversationHttpServiceTarget(
    assignment: ToolSandboxAssignment,
  ): Extract<SandboxHttpServiceTarget, { kind: "conversation" }> {
    return {
      kind: "conversation",
      targetId: assignment.sessionId,
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
    };
  }

  async #observeHttpServices(
    activation: ManagedToolBinding,
    handle: SandboxHandle,
    operationId: string,
    discovery: import("./sandbox-provider.ts").SandboxHttpServiceDiscovery,
  ): Promise<void> {
    await this.#serviceRegistry?.observe({
      target: this.#httpServiceTarget(activation),
      runtimeId: handle.runtimeId,
      activationId: activation.spec.activationId,
      operationId,
      listeningPorts: discovery.listeningPorts,
      httpServices: discovery.httpServices,
    });
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const [providerAssignments, durableAssignments] = await Promise.all([
      this.#provider.listAssignments(sandboxId),
      this.#stateRepository.listRuntimeAssignments(sandboxId),
    ]);
    const retainedRuntimeIds = new Set<string>();
    for (const activation of this.#toolBindings.values()) {
      const runtimeId = activation.elasticRuntime?.handle?.runtimeId;
      if (runtimeId !== undefined) retainedRuntimeIds.add(runtimeId);
    }
    for (const warm of this.#warm.values()) {
      if (warm.handle !== undefined) retainedRuntimeIds.add(warm.handle.runtimeId);
    }
    const assignments = new Map<string, SupervisorRuntimeAssignment>();
    for (const assignment of [...providerAssignments, ...durableAssignments].filter(
      (candidate) => !retainedRuntimeIds.has(candidate.containerId),
    )) {
      assignments.set(`${assignment.containerId}\0${assignment.executionLease}`, assignment);
    }
    return [...assignments.values()];
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const elasticBindings = [...this.#toolBindings.entries()].filter(
      ([, activation]) =>
        activation.elasticRuntime !== undefined &&
        sameSupervisorAssignment(activation.assignment, assignment),
    );
    if (elasticBindings.length > 0) {
      for (const [activationId, activation] of elasticBindings) {
        await this.#stopElasticBinding(activationId, activation);
      }
      return;
    }
    const managed = [...this.#toolBindings.entries()].filter(([, activation]) =>
      activation.handle === undefined ? false : samePhysicalRuntime(activation.handle, assignment),
    );
    for (const [activationId] of managed) this.#revokeBinding(activationId);
    const terminatedActivationIds = new Set(
      [...this.#admitted.entries()]
        .filter(([, admittedAssignment]) =>
          sameSupervisorAssignment(admittedAssignment, assignment),
        )
        .map(([activationId]) => activationId),
    );
    for (const [activationId] of managed) terminatedActivationIds.add(activationId);
    for (const [key, warm] of this.#warm) {
      if (warm.handle !== undefined && samePhysicalRuntime(warm.handle, assignment)) {
        this.#warm.delete(key);
        terminatedActivationIds.add(warm.physicalActivationId);
      }
    }
    await this.#provider.terminateAndConfirmAbsent(assignment);
    await this.#stateRepository.releaseRuntimeAssignment(assignment);
    for (const activationId of terminatedActivationIds) {
      this.#releaseAdmission(activationId);
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#provider.confirmAbsent(assignment);
  }

  async listWorkspaceDirectory(
    request: ToolBrokerListWorkspaceDirectoryRequest,
  ): Promise<ToolBrokerListWorkspaceDirectoryResponse> {
    if (this.#provider.listWorkspaceDirectory === undefined) {
      throw new ToolBrokerError(
        "workspace_browser_unavailable",
        "The configured Sandbox Provider cannot list Workspace directories",
        false,
      );
    }
    return this.#provider.listWorkspaceDirectory(request);
  }

  async readWorkspaceFile(
    request: ToolBrokerReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerReadWorkspaceFileResponse> {
    if (this.#provider.readWorkspaceFile === undefined) {
      throw new ToolBrokerError(
        "workspace_browser_unavailable",
        "The configured Sandbox Provider cannot read Workspace files",
        false,
      );
    }
    return this.#provider.readWorkspaceFile(request, signal);
  }

  async authorizeSourceCredential(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    if (this.#provider.authorizeSourceCredential === undefined) {
      throw new ToolBrokerError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot store Workspace Git credentials",
        false,
      );
    }
    return this.#provider.authorizeSourceCredential(request);
  }

  async preflightSourceCredential(
    request: SourceControlWorkspaceCredentialPreflightRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    if (this.#provider.preflightSourceCredential === undefined) {
      throw new ToolBrokerError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot verify Workspace Git credentials",
        false,
      );
    }
    return this.#provider.preflightSourceCredential(request);
  }

  async listSourceCredentials(
    request: SourceControlWorkspaceCredentialListRequest,
  ): Promise<SourceControlWorkspaceCredentialListResponse> {
    if (this.#provider.listSourceCredentials === undefined) {
      throw new ToolBrokerError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot list Workspace Git credentials",
        false,
      );
    }
    return this.#provider.listSourceCredentials(request);
  }

  async disconnectSourceCredential(
    request: SourceControlWorkspaceCredentialDisconnectRequest,
  ): Promise<SourceControlWorkspaceCredentialDisconnectResponse> {
    if (this.#provider.disconnectSourceCredential === undefined) {
      throw new ToolBrokerError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot disconnect Workspace Git credentials",
        false,
      );
    }
    return this.#provider.disconnectSourceCredential(request);
  }

  async close(): Promise<void> {
    clearInterval(this.#reaper);
    await this.#developmentEnvironmentRecovery?.catch(() => undefined);
    await Promise.all(
      [...this.#terminals.entries()].map(([terminalId, terminal]) =>
        this.#closeTerminal(terminalId, terminal).catch(() => undefined),
      ),
    );
    for (const [environmentId, environment] of this.#developmentEnvironments) {
      environment.terminal?.disconnect();
      await environment.terminal?.kill().catch(() => undefined);
      let capsule: string | undefined;
      let detachableHandle = environment.handle;
      try {
        const bindings = [...environment.bindingIds]
          .map((bindingId) => this.#toolBindings.get(bindingId))
          .filter((binding): binding is ManagedToolBinding => binding !== undefined);
        if (bindings.length > 0) {
          for (const binding of bindings) {
            detachableHandle =
              binding.materializing === undefined
                ? (binding.handle ?? detachableHandle)
                : ((await binding.materializing.catch(() => undefined)) ?? detachableHandle);
            this.#toolBindings.delete(binding.activationId);
          }
          environment.handle = detachableHandle;
          environment.bindingIds.clear();
          capsule = await this.#persistentCapsule(detachableHandle);
          if (capsule === undefined) {
            throw new ToolBrokerError(
              "persistent_machine_recovery_state_unavailable",
              "Exclusive machine recovery state was unavailable during Tool Broker shutdown",
              false,
            );
          }
          await this.#stateRepository.returnDevelopmentEnvironment(
            environmentId,
            environmentId,
            "running",
            { handle: detachableHandle, runtimeCapsule: capsule },
          );
        } else {
          const inspection = await this.#provider.inspect(detachableHandle);
          if (inspection.state === "absent") {
            throw new ToolBrokerError(
              "persistent_machine_disappeared",
              "Exclusive machine disappeared during Tool Broker shutdown",
              false,
            );
          }
          capsule = await this.#persistentCapsule(detachableHandle);
          if (capsule === undefined) {
            throw new ToolBrokerError(
              "persistent_machine_recovery_state_unavailable",
              "Exclusive machine recovery state was unavailable during Tool Broker shutdown",
              false,
            );
          }
          await this.#stateRepository.setDevelopmentEnvironmentState(
            environmentId,
            inspection.state === "running" ? "running" : "paused",
            { handle: detachableHandle, runtimeCapsule: capsule },
          );
        }
        await this.#provider.detachPersistent?.(detachableHandle);
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(environmentId, "unknown", {
            handle: detachableHandle,
            failureCode: operationFailureCode(error),
            ...(capsule === undefined ? {} : { runtimeCapsule: capsule }),
          })
          .catch(() => undefined);
        await this.#provider.detachPersistent?.(detachableHandle).catch(() => undefined);
      }
      this.#releaseAdmission(environmentId);
    }
    this.#developmentEnvironments.clear();
    const ownedActivationIds = new Set<string>();
    for (const [activationId, activation] of this.#toolBindings) {
      ownedActivationIds.add(activation.elasticRuntime?.physicalActivationId ?? activationId);
    }
    for (const warm of this.#warm.values()) {
      ownedActivationIds.add(warm.physicalActivationId);
    }
    for (const activationId of this.#toolBindings.keys()) {
      this.#revokeBinding(activationId);
    }
    this.#warm.clear();
    for (const waiter of this.#admissionWaiters.splice(0)) {
      this.#removeAbortListener(waiter);
      waiter.reject(
        new ToolBrokerError("tool_binding_admission_closed", "Tool binding admission closed", true),
      );
    }
    this.#admitted.clear();
    try {
      await this.#provider.close();
      for (const activationId of ownedActivationIds) {
        await this.#stateRepository.setWorkspaceRuntimeState(activationId, "released");
      }
    } finally {
      await this.#stateRepository.close();
    }
  }

  async #persistentCapsule(handle: SandboxHandle): Promise<string | undefined> {
    if (this.#provider.persistentCapsule === undefined) {
      return undefined;
    }
    try {
      return (await this.#provider.persistentCapsule(handle)).capsule;
    } catch (error: unknown) {
      if (error instanceof ToolBrokerError && error.code === "persistent_capsule_key_missing") {
        return undefined;
      }
      throw error;
    }
  }

  async reapWarm(): Promise<void> {
    const now = this.#now();
    const expired = [...this.#warm.entries()].filter(([, warm]) => warm.expiresAt <= now);
    for (const [key, warm] of expired) {
      if (this.#warm.get(key) !== warm) continue;
      await this.#discardWarm(key, warm);
    }
  }

  async reapRetiredWarm(): Promise<void> {
    const retired = new Set(await this.#stateRepository.listRetiredWarmWorkspaceRuntimeIds());
    if (retired.size === 0) return;
    for (const [key, warm] of this.#warm) {
      if (!retired.has(warm.physicalActivationId) || this.#warm.get(key) !== warm) continue;
      await this.#discardWarm(key, warm);
    }
  }

  #authorizedBinding(activationId: string, executionLease: string): ManagedToolBinding {
    const activation = this.#toolBindings.get(activationId);
    if (activation === undefined || activation.assignment.executionLease !== executionLease) {
      throw new ToolBrokerError(
        "stale_session_lease",
        "Tool binding operation used a stale Session lease",
        false,
      );
    }
    return activation;
  }

  #ownedBinding(activationId: string, assignment: ToolSandboxAssignment): ManagedToolBinding {
    const activation = this.#toolBindings.get(activationId);
    if (activation === undefined || !sameAssignment(activation.assignment, assignment)) {
      throw new ToolBrokerError(
        "tool_binding_identity_mismatch",
        "Tool binding assignment identity did not match",
        false,
      );
    }
    return activation;
  }

  #revokeBinding(activationId: string): void {
    this.#toolBindings.delete(activationId);
    this.#cancelAdmissionWaiter(activationId);
  }

  async #materialize(activation: ManagedToolBinding, signal?: AbortSignal): Promise<SandboxHandle> {
    if (activation.elasticRuntime !== undefined) {
      const handle = await this.#materializeElasticRuntime(activation.elasticRuntime, signal);
      activation.usedPhysicalRuntime = true;
      return handle;
    }
    const handle = activation.handle;
    if (activation.developmentEnvironmentId === undefined || handle === undefined) {
      throw new ToolBrokerError(
        "development_environment_unavailable",
        "Development environment runtime is unavailable",
        true,
      );
    }
    if (signal?.aborted) {
      throw new ToolBrokerError("tool_operation_cancelled", "Tool operation was cancelled", false);
    }
    if (
      handle.activationId !== activation.spec.activationId ||
      handle.assignment.tenantId !== activation.assignment.tenantId ||
      handle.assignment.projectId !== activation.assignment.projectId ||
      handle.assignment.workspaceId !== activation.assignment.workspaceId ||
      !sameEnvironment(handle.environment, activation.spec.environment)
    ) {
      throw new ToolBrokerError(
        "sandbox_provider_protocol_error",
        "Development environment returned a mismatched handle",
        false,
      );
    }
    activation.usedPhysicalRuntime = true;
    await this.#stateRepository.setWorkspaceRuntimeState(
      activation.reservation.activationId,
      "active",
      { handle },
    );
    return handle;
  }

  async #materializeElasticRuntime(
    runtime: ManagedElasticRuntime,
    signal?: AbortSignal,
  ): Promise<SandboxHandle> {
    if (runtime.failure !== undefined) throw runtime.failure;
    if (runtime.handle !== undefined) return runtime.handle;
    if (runtime.materializing !== undefined) return runtime.materializing;
    const materializing = (async (): Promise<SandboxHandle> => {
      await this.#stateRepository.setWorkspaceRuntimeState(
        runtime.physicalActivationId,
        "materializing",
      );
      await this.#acquireAdmission(runtime.physicalActivationId, runtime.spec.assignment, signal);
      try {
        const handle = await this.#provider.create(runtime.spec);
        if (
          !handleMatches(
            handle,
            this.#provider,
            runtime.physicalActivationId,
            runtime.spec.assignment,
            runtime.environment,
            runtime.spec.toolRoot ?? "/workspace",
          )
        ) {
          await this.#provider.destroy(handle).catch(() => undefined);
          throw new ToolBrokerError(
            "sandbox_provider_protocol_error",
            "Sandbox Provider returned a mismatched Workspace runtime handle",
            false,
          );
        }
        runtime.handle = handle;
        await this.#stateRepository.setWorkspaceRuntimeState(
          runtime.physicalActivationId,
          "active",
          {
            handle,
          },
        );
        return handle;
      } catch (error: unknown) {
        this.#releaseAdmission(runtime.physicalActivationId);
        await this.#stateRepository
          .setWorkspaceRuntimeState(runtime.physicalActivationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
    })();
    runtime.materializing = materializing;
    try {
      return await materializing;
    } finally {
      delete runtime.materializing;
    }
  }

  async #markElasticRuntimeLost(runtime: ManagedElasticRuntime, error: unknown): Promise<void> {
    const failure =
      error instanceof ToolBrokerError
        ? error
        : new ToolBrokerError(
            "workspace_runtime_lost",
            "Workspace runtime was lost during Tool execution",
            true,
            error,
          );
    runtime.failure = failure;
    delete runtime.handle;
    if (runtime.workspaceTerminalId !== undefined) {
      const terminal = this.#terminals.get(runtime.workspaceTerminalId);
      terminal?.session.disconnect();
      await terminal?.session.kill().catch(() => undefined);
      this.#terminals.delete(runtime.workspaceTerminalId);
      await this.#stateRepository
        .setTerminalState(runtime.workspaceTerminalId, "unknown", {
          failureCode: failure.code,
        })
        .catch(() => undefined);
      delete runtime.workspaceTerminalId;
    }
    this.#releaseAdmission(runtime.physicalActivationId);
    await this.#stateRepository
      .setWorkspaceRuntimeState(runtime.physicalActivationId, "unknown", {
        failureCode: failure.code,
      })
      .catch(() => undefined);
  }

  async #enforceWarmLimit(): Promise<void> {
    while (this.#warm.size > this.#maximumWarmWorkspaceRuntimes) {
      const oldest = [...this.#warm.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest === undefined) return;
      await this.#discardWarm(oldest[0], oldest[1]);
    }
  }

  async #reapOrphanedWorkspaceRuntimes(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedWorkspaceRuntimes(16);
    for (const orphan of orphaned) {
      try {
        await this.#provider.destroyRuntime(orphan.activationId, orphan.assignment);
        await this.#stateRepository.setWorkspaceRuntimeState(orphan.activationId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setWorkspaceRuntimeState(orphan.activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapUnboundWorkspaceRuntimes(minimumUnboundAgeMs?: number): Promise<void> {
    const orphaned = await this.#stateRepository.claimUnboundWorkspaceRuntimes(
      16,
      minimumUnboundAgeMs,
    );
    for (const orphan of orphaned) {
      const local = this.#toolBindings.get(orphan.activationId);
      if (local !== undefined) this.#revokeBinding(orphan.activationId);
      this.#releaseAdmission(orphan.activationId);
      try {
        await this.#provider.destroyRuntime(orphan.activationId, orphan.assignment);
        await this.#stateRepository.setWorkspaceRuntimeState(orphan.activationId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setWorkspaceRuntimeState(orphan.activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapOrphanedTerminals(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedTerminals(16);
    for (const terminal of orphaned) {
      const assignment = terminalAssignment(
        terminal.terminalId,
        terminal,
        createExecutionLease(terminal.terminalId, terminal.terminalId, terminal.fencingToken),
      );
      try {
        await this.#provider.destroyRuntime(terminal.terminalId, assignment);
        await this.#stateRepository.setTerminalState(terminal.terminalId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setTerminalState(terminal.terminalId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  async #reapOrphanedDevelopmentEnvironments(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedDevelopmentEnvironments(16);
    for (const environment of orphaned) {
      const local = this.#developmentEnvironments.get(environment.environmentId);
      local?.terminal?.disconnect();
      if (local?.terminal !== undefined) await local.terminal.kill().catch(() => undefined);
      this.#developmentEnvironments.delete(environment.environmentId);
      const assignment = developmentEnvironmentAssignment({
        environmentId: environment.environmentId,
        tenantId: environment.tenantId,
        projectId: environment.projectId,
        workspaceId: environment.workspaceId,
        generation: environment.generation,
      });
      try {
        await this.#provider.destroyRuntime(environment.environmentId, assignment);
        this.#releaseAdmission(environment.environmentId);
        await this.#stateRepository.setDevelopmentEnvironmentState(
          environment.environmentId,
          "failed",
          { failureCode: "tool_broker_owner_lost" },
        );
      } catch (error: unknown) {
        await this.#stateRepository
          .setDevelopmentEnvironmentState(environment.environmentId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    }
  }

  #closeTerminal(terminalId: string, terminal: ManagedWorkspaceTerminal): Promise<void> {
    terminal.closing ??= (async () => {
      this.#terminals.delete(terminalId);
      await this.#stateRepository.setTerminalState(terminalId, "cleaning").catch(() => undefined);
      terminal.session.disconnect();
      await terminal.session.kill().catch(() => undefined);
      const workspaceRuntime = terminal.workspaceRuntime;
      if (workspaceRuntime !== undefined) {
        delete workspaceRuntime.workspaceTerminalId;
        if (workspaceRuntime.bindingIds.size === 0) {
          const now = this.#now();
          workspaceRuntime.lastUsedAt = now;
          workspaceRuntime.expiresAt = now + this.#warmTtlMs;
          this.#warm.set(workspaceRuntime.workspaceKey, workspaceRuntime);
          await this.#stateRepository.setWorkspaceRuntimeState(
            workspaceRuntime.physicalActivationId,
            "warm",
            {
              ...(workspaceRuntime.handle === undefined ? {} : { handle: workspaceRuntime.handle }),
              workspaceRevision: workspaceRuntime.workspaceRevision,
            },
          );
        }
        await this.#stateRepository.setTerminalState(terminalId, "released");
        return;
      }
      const borrower = [...this.#toolBindings.entries()].find(
        ([, activation]) => activation.elasticRuntime?.workspaceTerminalId === terminalId,
      );
      if (borrower !== undefined) {
        const [activationId, activation] = borrower;
        if (activation.elasticRuntime !== undefined) {
          delete activation.elasticRuntime.workspaceTerminalId;
        } else if (this.#admitted.delete(terminalId)) {
          this.#admitted.set(activationId, activation.assignment);
        }
        await this.#stateRepository.setTerminalState(terminalId, "released");
        return;
      }
      try {
        await this.#provider.destroy(terminal.handle);
        this.#releaseAdmission(terminalId);
        await this.#stateRepository.setTerminalState(terminalId, "released");
      } catch (error: unknown) {
        await this.#stateRepository
          .setTerminalState(terminalId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
        throw error;
      }
    })();
    return terminal.closing;
  }

  async #acquireAdmission(
    activationId: string,
    assignment: ToolSandboxAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#admitted.has(activationId)) return;
    if (signal?.aborted) {
      throw new ToolBrokerError(
        "tool_binding_admission_cancelled",
        "Tool binding admission was cancelled",
        false,
      );
    }
    while (this.#admitted.size >= this.#maximumActiveSandboxes) {
      const oldest = [...this.#warm.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest === undefined) break;
      if (this.#warm.get(oldest[0]) !== oldest[1]) continue;
      await this.#discardWarm(oldest[0], oldest[1]);
      if (signal?.aborted) {
        throw new ToolBrokerError(
          "tool_binding_admission_cancelled",
          "Tool binding admission was cancelled",
          false,
        );
      }
    }
    if (this.#admitted.size < this.#maximumActiveSandboxes) {
      this.#admitted.set(activationId, assignment);
      return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const waiter: AdmissionWaiter = {
        activationId,
        assignment,
        ...(signal === undefined ? {} : { signal }),
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#admissionWaiters.indexOf(waiter);
          if (index >= 0) this.#admissionWaiters.splice(index, 1);
          this.#removeAbortListener(waiter);
          rejectPromise(
            new ToolBrokerError(
              "tool_binding_admission_cancelled",
              "Tool binding admission was cancelled",
              false,
            ),
          );
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#admissionWaiters.push(waiter);
    });
  }

  async #discardWarm(key: string, warm: ManagedElasticRuntime): Promise<void> {
    if (this.#warm.get(key) === warm) this.#warm.delete(key);
    if (warm.handle !== undefined) {
      await this.#provider.stop(warm.handle);
      await this.#serviceRegistry?.endRuntime(warm.handle.runtimeId).catch(() => undefined);
    }
    this.#releaseAdmission(warm.physicalActivationId);
    await this.#stateRepository.setWorkspaceRuntimeState(warm.physicalActivationId, "released");
  }

  async #serializeWorkspaceRuntimeProvisioning<T>(
    assignment: ToolSandboxAssignment,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = workspaceIdentityKey(assignment);
    const previous = this.#workspaceRuntimeProvisioningTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.#workspaceRuntimeProvisioningTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#workspaceRuntimeProvisioningTails.get(key) === tail) {
        this.#workspaceRuntimeProvisioningTails.delete(key);
      }
    }
  }

  #releaseAdmission(activationId: string): void {
    if (!this.#admitted.delete(activationId)) return;
    while (this.#admissionWaiters.length > 0) {
      const waiter = this.#admissionWaiters.shift();
      if (waiter === undefined) return;
      this.#removeAbortListener(waiter);
      if (waiter.signal?.aborted) continue;
      this.#admitted.set(waiter.activationId, waiter.assignment);
      waiter.resolve();
      return;
    }
  }

  #cancelAdmissionWaiter(activationId: string): void {
    const index = this.#admissionWaiters.findIndex(
      (waiter) => waiter.activationId === activationId,
    );
    if (index < 0) return;
    const [waiter] = this.#admissionWaiters.splice(index, 1);
    if (waiter === undefined) return;
    this.#removeAbortListener(waiter);
    waiter.reject(
      new ToolBrokerError(
        "tool_binding_admission_cancelled",
        "Tool binding admission was cancelled",
        false,
      ),
    );
  }

  #removeAbortListener(waiter: AdmissionWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Tool Broker clock returned an invalid timestamp");
    }
    return value;
  }
}
