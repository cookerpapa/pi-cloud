import { resourceLimit } from "@pi-cloud/domain";
import { WorkspaceFileAccess } from "./workspace-file-access.ts";
import { createWorkspaceSeed, encodeWorkspaceBlob } from "@pi-cloud/workspace-runtime";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";
import { BindingClosurePending, type SandboxBindings } from "./sandbox-bindings.ts";
import { PostgresQueueWake } from "@pi-cloud/database";
import {
  runWorkspaceRuntimeCleanup,
  type WorkspaceCleanupWake,
} from "./workspace-runtime-cleanup.ts";
import { WorkflowChannels, type WorkflowFrame } from "./workflow-channels.ts";
import { SandboxAdmission } from "./sandbox-admission.ts";
import PQueue from "p-queue";
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
  ToolSandboxCreateRequest,
  ToolSandboxCreateResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
  NativeToolUpdate,
  ToolSandboxReleaseRequest,
  ToolSandboxReleaseResponse,
  SandboxControlListWorkspaceDirectoryRequest,
  SandboxControlListWorkspaceDirectoryResponse,
  SandboxControlReadWorkspaceFileRequest,
  SandboxControlReadWorkspaceFileResponse,
  CloudToolName,
  SandboxPreviewConnectionRequest,
  SourceControlWorkspaceCredentialAuthorizeRequest,
  SourceControlWorkspaceCredentialDisconnectRequest,
  SourceControlWorkspaceCredentialDisconnectResponse,
  SourceControlWorkspaceCredentialListRequest,
  SourceControlWorkspaceCredentialListResponse,
  SourceControlWorkspaceCredentialPreflightRequest,
  SourceControlWorkspaceCredentialResponse,
} from "@pi-cloud/protocol";
import type { WorkspaceUploadRequest } from "@pi-cloud/protocol";
import type { ImageAttachmentSource, ImageAttachmentStore } from "@pi-cloud/session-attachments";
import { type SandboxControlRequest, type SandboxControlResponse } from "@pi-cloud/protocol";
type InputImageRequest = Extract<
  SandboxControlRequest,
  { type: "tool_sandbox.prepare_input_images" }
>;
type InputImageResponse = Extract<
  SandboxControlResponse,
  { type: "tool_sandbox.input_images_prepared" }
>;
type ToolImageRequest = Extract<SandboxControlRequest, { type: "tool_sandbox.image_io" }>;
type ToolImageResponse = Extract<SandboxControlResponse, { type: "tool_sandbox.image_io_result" }>;
import {
  createExecutionReference,
  parseCloudToolCapabilitySnapshot,
  parseExecutionReference,
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
  SandboxControlError,
  SandboxCreationError,
  type SandboxHandle,
  type SandboxCreateSpec,
  type SandboxInspection,
  type SandboxProvider,
  type SandboxLifecycle,
  type SandboxExecution,
  type SandboxWorkspaceFiles,
  type SandboxImages,
  type SandboxTerminals,
  type SandboxPreviews,
  type SandboxWorkflows,
  type SandboxSourceCredentials,
  type SandboxTerminalSession,
  type SandboxTerminalSize,
} from "./sandbox-provider.ts";
import {
  type WorkspaceRuntimeReservation,
  type WorkspaceRuntimeStateRepository,
  type DevelopmentEnvironmentReservation,
  type OrphanedWorkspaceRuntime,
  type AllocationKind,
  type AllocationRecovery,
  type RecoverableDevelopmentEnvironment,
} from "./workspace-runtime-state-repository.ts";
import type {
  SandboxHttpServiceRegistry,
  SandboxHttpServiceTarget,
} from "./sandbox-http-service-registry.ts";

export type SandboxControllerOptions = {
  controlReady?: () => boolean;
  bindings: SandboxBindings;
  workspaceCleanupWake?: WorkspaceCleanupWake;
  inputImages?: ImageAttachmentSource & Pick<ImageAttachmentStore, "put">;
  provider: SandboxProvider;
  ownerBaseUrl: string;
  stateRepository: WorkspaceRuntimeStateRepository;
  idGenerator?: () => string;
  maximumActiveSandboxes?: number | null;
  runtimeProbeConcurrency?: number;
  onProbeSample?(stage: "probe" | "scheduling", durationMs: number, outcome: string): void;
  clock?: () => number;
  elasticRetentionMs?: number;
  imageRevision: string;
  serviceRegistry?: SandboxHttpServiceRegistry;
  onMaintenanceError?: (error: unknown) => void;
};

export class SandboxOwnerRedirectError extends Error {
  readonly ownerBaseUrl: string;

  constructor(ownerBaseUrl: string) {
    super("Tool binding is owned by another Sandbox control replica");
    this.name = "SandboxOwnerRedirectError";
    this.ownerBaseUrl = ownerBaseUrl;
  }
}

type ManagedToolBinding = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  turnContextSha256: string;
  executionContextSha256: string;
  currentStep?: Readonly<{ sequence: number; sha256: string }>;
  allowedTools: ReadonlySet<CloudToolName>;
  spec: SandboxCreateSpec;
  reservation: WorkspaceRuntimeReservation;
  handle?: SandboxHandle;
  usedPhysicalRuntime: boolean;
  activeOperations: number;
  inputClosed?: boolean;
  operations: Map<
    string,
    Readonly<{
      requestSha256: string;
      result: Promise<ToolSandboxOperationResponse | InputImageResponse | ToolImageResponse>;
      controller: AbortController;
    }>
  >;

  elasticRuntime?: ManagedElasticRuntime;
  developmentEnvironmentId?: string;
};

type ManagedElasticRuntime = {
  capsuleStored?: boolean;
  physicalActivationId: string;
  workspaceKey: string;
  spec: SandboxCreateSpec;
  handle?: SandboxHandle;
  materializing?: Promise<SandboxHandle>;
  bindingIds: Set<string>;
  activeOperations: number;
  environment: EnvironmentRuntimeSnapshot;
  sandboxProfileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
  workspaceTerminalId?: string;
  failure?: SandboxControlError;
  failureRecorded?: boolean;
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
  observedState: "running" | "paused";
  observedAt: number;
  assignment: ToolSandboxAssignment;
  handle: SandboxHandle;
  terminal?: SandboxTerminalSession;
  bindingIds: Set<string>;
  failure?: SandboxControlError;
  failureRecorded?: boolean;
  closureConfirmed?: boolean;
};

function workspaceIdentityKey(
  assignment: Pick<ToolSandboxAssignment, "tenantId" | "projectId" | "workspaceId">,
): string {
  return [assignment.tenantId, assignment.projectId, assignment.workspaceId].join("\0");
}

function operationFailureCode(error: unknown): string {
  return error instanceof SandboxControlError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : "tool_broker_failed";
}

const TOOL_OPERATIONS: Readonly<Record<CloudToolName, ReadonlySet<string>>> = {
  read: new Set(["tool.execute"]),
  write: new Set(["tool.execute"]),
  edit: new Set(["tool.execute"]),
  bash: new Set(["tool.execute", "workflow.exec"]),
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
    throw new TypeError("Sandbox control ID generator returned an invalid UUID");
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
    left.executionReference === right.executionReference
  );
}

function handleMatches(
  handle: SandboxHandle,
  provider: Pick<SandboxLifecycle, "providerId">,
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
    left.executionReference === right.executionReference
  );
}

function terminalAssignment(
  terminalId: string,
  input: Pick<WorkspaceTerminalOpenInput, "tenantId" | "projectId" | "workspaceId" | "sessionId">,
  executionReference: string,
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
    executionReference,
  };
}

function developmentEnvironmentAssignment(
  input: Pick<
    DevelopmentEnvironmentProvisionRequest,
    "environmentId" | "allocationId" | "tenantId" | "projectId" | "workspaceId" | "generation"
  >,
): ToolSandboxAssignment {
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    supervisorId: "development-environment",
    bootId: input.allocationId,
    sandboxId: input.allocationId,
    runId: input.allocationId,
    sessionId: input.allocationId,
    turnId: input.allocationId,
    executionReference: createExecutionReference(
      input.allocationId,
      input.allocationId,
      input.generation,
    ),
  };
}

export class SandboxController {
  readonly #bindings: SandboxBindings;
  readonly #inputImages: (ImageAttachmentSource & Pick<ImageAttachmentStore, "put">) | undefined;
  readonly #inputPreparation = new PQueue({ concurrency: 1 });
  readonly #workflowChannels = new WorkflowChannels();
  readonly #provider: SandboxLifecycle;
  readonly #execution: SandboxExecution;
  readonly #files: SandboxWorkspaceFiles;
  readonly #images: SandboxImages;
  readonly #terminalsProvider: SandboxTerminals;
  readonly #previews: SandboxPreviews;
  readonly #workflows: SandboxWorkflows;
  readonly #credentials: SandboxSourceCredentials;
  readonly #workspaceFiles: WorkspaceFileAccess;
  readonly #ownerBaseUrl: string;
  readonly #stateRepository: WorkspaceRuntimeStateRepository;
  readonly #serviceRegistry: SandboxHttpServiceRegistry | undefined;
  readonly #idGenerator: () => string;
  readonly #maximumActiveSandboxes: number | null;
  readonly #clock: () => number;
  readonly #elasticRetentionMs: number;
  readonly #imageRevision: string;
  readonly #onMaintenanceError: ((error: unknown) => void) | undefined;
  readonly #toolBindings = new Map<string, ManagedToolBinding>();
  readonly #warm = new Map<string, ManagedElasticRuntime>();
  readonly #terminals = new Map<string, ManagedWorkspaceTerminal>();
  readonly #developmentEnvironments = new Map<string, ManagedDevelopmentEnvironment>();
  readonly #admission: SandboxAdmission;
  readonly #workspaceRuntimeProvisioningTails = new Map<string, Promise<void>>();
  readonly #reaper: NodeJS.Timeout;
  readonly #cleanupController = new AbortController();
  readonly #cleanupLoop: Promise<void>;
  #workspaceCleanup: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  readonly #runtimeHealth: RuntimeHealthMonitor;
  readonly #controlReady: () => boolean;
  #developmentEnvironmentRecovery: Promise<number> | undefined;

  constructor(options: SandboxControllerOptions) {
    this.#bindings = options.bindings;
    this.#inputImages = options.inputImages;
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(options.provider.providerId)) {
      throw new TypeError("Sandbox Provider ID is invalid");
    }
    this.#provider = options.provider;
    this.#execution = options.provider;
    this.#files = options.provider;
    this.#images = options.provider;
    this.#terminalsProvider = options.provider;
    this.#previews = options.provider;
    this.#workflows = options.provider;
    this.#credentials = options.provider;
    this.#workspaceFiles = new WorkspaceFileAccess(options.provider, {
      machine: (request) => this.#machineBrowserHandle(request),
      upload: (request) => this.#authorizeUpload(request),
    });
    this.#ownerBaseUrl = new URL(options.ownerBaseUrl).toString();
    this.#stateRepository = options.stateRepository;
    this.#serviceRegistry = options.serviceRegistry;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#maximumActiveSandboxes = resourceLimit(
      options.maximumActiveSandboxes,
      "maximumActiveSandboxes",
    );
    this.#admission = new SandboxAdmission(this.#maximumActiveSandboxes);
    this.#clock = options.clock ?? Date.now;
    this.#elasticRetentionMs = options.elasticRetentionMs ?? 900000;
    if (
      !Number.isSafeInteger(this.#elasticRetentionMs) ||
      this.#elasticRetentionMs < 1000 ||
      this.#elasticRetentionMs > 86400000
    )
      throw new TypeError("Elastic retention policy is invalid");
    this.#imageRevision = options.imageRevision;
    this.#controlReady = options.controlReady ?? (() => true);
    this.#onMaintenanceError = options.onMaintenanceError;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#imageRevision)) {
      throw new TypeError("Workspace runtime image revision is invalid");
    }
    this.#reaper = setInterval(() => {
      if (!this.#controlReady()) return;
      void Promise.all([
        this.recoverPersistentDevelopmentEnvironments(),
        this.#stateRepository.reconcileOwnership().then(() => this.#reapOrphanedTerminals()),
      ]).catch((error: unknown) => this.#onMaintenanceError?.(error));
    }, 30_000);
    this.#reaper.unref();
    this.#cleanupLoop = runWorkspaceRuntimeCleanup(
      options.workspaceCleanupWake ?? new PostgresQueueWake(),
      this.#cleanupController.signal,
      () => (this.#controlReady() ? this.reapWorkspaceRuntimes() : Promise.resolve()),
      (error) => this.#onMaintenanceError?.(error),
    );
    this.#runtimeHealth = new RuntimeHealthMonitor({
      targets: () => this.#runtimeHealthTargets(),
      inventory: () => this.#provider.observeRuntimeInventory(),
      onError: (error) => this.#onMaintenanceError?.(error),
      ...(options.runtimeProbeConcurrency === undefined
        ? {}
        : { concurrency: options.runtimeProbeConcurrency }),
      ...(options.onProbeSample ? { sample: options.onProbeSample } : {}),
      clock: this.#clock,
    });
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
    return this.#admission.size;
  }

  get admissionWaitingCount(): number {
    return this.#admission.waitingCount;
  }

  get maximumActiveSandboxes(): number | null {
    return this.#maximumActiveSandboxes;
  }

  get reservedCount(): number {
    return this.#toolBindings.size;
  }

  async #createPhysical(spec: SandboxCreateSpec, kind?: AllocationKind): Promise<SandboxHandle> {
    if (spec.lifetime !== "development_environment")
      spec = { ...spec, retentionWindowMs: spec.retentionWindowMs ?? this.#elasticRetentionMs };
    const authorization = await this.#stateRepository.beginCreation(spec, kind);
    try {
      return await this.#provider.create(spec, authorization);
    } catch (error) {
      if (
        Date.now() >= authorization.createBefore ||
        (error instanceof SandboxCreationError &&
          (error.absenceConfirmed || error.code === "environment_preflight_mismatch"))
      ) {
        let absent = false;
        try {
          await this.#closePhysical(
            spec.activationId,
            spec.assignment,
            kind ??
              (spec.lifetime === "development_environment"
                ? "development_environment"
                : "workspace"),
          );
          absent = true;
        } catch {
          /* An earlier same-ID create may already exist. */
        }
        throw new SandboxCreationError(error, absent);
      }
      throw error;
    }
  }

  async #recoverPhysical(candidate: {
    runtimeCapsule?: string;
    creation?: AllocationRecovery;
  }): Promise<SandboxHandle> {
    if (candidate.runtimeCapsule)
      return this.#provider.adoptPersistentCapsule!(candidate.runtimeCapsule);
    if (!candidate.creation) throw new Error("Runtime creation identity is unavailable");
    return this.#createPhysical(candidate.creation.spec);
  }

  async #closePhysical(
    id: string,
    assignment: ToolSandboxAssignment,
    kind: AllocationKind,
    handle?: SandboxHandle,
    capsule?: string,
  ): Promise<void> {
    const intent = await this.#stateRepository.closeAllocation(id, kind);
    if (intent.status === "never_issued" && !handle && !capsule) return;
    if (intent.status !== "authorized")
      throw new SandboxControlError(
        "cubesandbox_allocation_identity_unavailable",
        "Allocation requires independent physical verification",
        false,
      );
    if (handle) {
      if (
        handle.activationId !== id ||
        handle.allocation.createBefore !== intent.authorization.createBefore
      )
        throw new SandboxControlError(
          "cubesandbox_allocation_identity_unavailable",
          "Allocation handle changed",
          false,
        );
      await this.#provider.destroy(handle);
    } else if (capsule) await this.#provider.destroyPersistentCapsule(capsule, id, assignment);
    else await this.#provider.destroyRuntime(id, assignment, intent.authorization);
  }

  async recoverPersistentDevelopmentEnvironments(): Promise<number> {
    if (this.#developmentEnvironmentRecovery !== undefined) {
      return this.#developmentEnvironmentRecovery;
    }
    const recovery = (async () => {
      const machines = await this.#recoverPersistentDevelopmentEnvironments();
      return machines + (await this.#recoverElasticRuntimes());
    })();
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
    if (!this.#provider.adoptPersistentCapsule) return 0;
    const candidates = await this.#stateRepository.claimRecoverableDevelopmentEnvironments(256, [
      ...this.#developmentEnvironments.keys(),
    ]);
    let recovered = 0;
    const pending = [...candidates];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        for (let candidate = pending.shift(); candidate; candidate = pending.shift()) {
          try {
            recovered += await this.#serializeWorkspaceRuntimeProvisioning(
              developmentEnvironmentAssignment(candidate.reservation),
              () => this.#reconcileDevelopmentEnvironment(candidate!),
            );
          } catch (error) {
            this.#onMaintenanceError?.(error);
          }
        }
      }),
    );
    return recovered;
  }

  async #reconcileDevelopmentEnvironment(
    candidate: RecoverableDevelopmentEnvironment,
  ): Promise<number> {
    let identity = candidate.reservation;
    let environment = this.#developmentEnvironments.get(identity.environmentId);
    let handle = environment?.handle;
    let adopted = false;
    let physicalVerified = false;
    let bootstrap =
      candidate.creation?.spec ??
      (candidate.environment
        ? {
            activationId: identity.allocationId,
            assignment: developmentEnvironmentAssignment(identity),
            environment: candidate.environment,
            workspaceSeed: {
              kind: "bundle" as const,
              bundle: encodeWorkspaceBlob(createWorkspaceSeed([])),
            },
            policy: this.#provider.defaultPolicy,
            toolRoot: DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
            lifetime: "development_environment" as const,
            sandboxProfileKey: identity.profileKey,
          }
        : undefined);
    try {
      const ownership = await this.#stateRepository.developmentEnvironmentOwner(
        identity.tenantId,
        identity.userId,
        identity.environmentId,
      );
      if (
        ownership.status !== "owned" ||
        ownership.reservation.allocationId !== identity.allocationId ||
        ownership.reservation.intentRevision !== identity.intentRevision
      )
        return 0;
      identity = ownership.reservation;
      if (environment && environment.reservation.allocationId !== identity.allocationId) return 0;
      if (identity.desiredState === "released") {
        if (ownership.agentActive || ownership.terminalActive) return 0;
        await this.#retireDevelopmentAllocation(identity, handle, candidate.runtimeCapsule);
        await this.#stateRepository.setDevelopmentEnvironmentState(identity, "released");
        return 1;
      }
      const observation = identity.allocationClosed
        ? undefined
        : handle
          ? await this.#provider.observeRuntime(handle)
          : candidate.creation
            ? await this.#provider.observeAllocation?.(
                identity.allocationId,
                candidate.creation.authorization,
                candidate.runtimeCapsule,
              )
            : undefined;
      const physicalLost =
        observation?.presence === "absent" ||
        observation?.execution === "unsafe" ||
        (observation?.presence === "present" && ["stopped", "error"].includes(observation.state));
      const unstartedExpired =
        !candidate.runtimeCapsule &&
        !handle &&
        !observation &&
        candidate.creation &&
        Date.now() >= candidate.creation.authorization.createBefore;
      if (
        identity.allocationClosed ||
        candidate.allocationAbsent ||
        physicalLost ||
        unstartedExpired
      ) {
        await this.#stateRepository.setDevelopmentEnvironmentState(identity, "reconciling");
        await this.#retireDevelopmentAllocation(identity, handle, candidate.runtimeCapsule);
        if (identity.desiredState !== "running") {
          await this.#stateRepository.setDevelopmentEnvironmentState(identity, "failed", {
            failureCode: "development_machine_stopped",
          });
          return 0;
        }
        if (!bootstrap) return 0;
        if (bootstrap.environment.imageRevision !== this.#imageRevision) {
          const environment = await this.#stateRepository.prepareDevelopmentEnvironmentImage(
            identity,
            this.#imageRevision,
          );
          identity = { ...identity, environmentVersionId: environment.environmentVersionId };
          bootstrap = { ...bootstrap, environment };
        }
        const allocationId = validActivationId(this.#idGenerator());
        const nextIdentity = { ...identity, allocationId, generation: identity.generation + 1 };
        const spec = {
          ...bootstrap,
          activationId: allocationId,
          assignment: developmentEnvironmentAssignment(nextIdentity),
        };
        identity = await this.#stateRepository.replaceDevelopmentEnvironmentAllocation(
          identity,
          spec,
        );
        environment = undefined;
        handle = undefined;
        await this.#admission.acquire(identity.allocationId, spec.assignment);
        handle = await this.#createPhysical(spec, "development_environment");
        adopted = true;
      } else {
        if (observation?.presence === "unavailable") return 0;
        if (!handle) {
          if (
            !candidate.runtimeCapsule &&
            !candidate.creation &&
            identity.desiredState === "paused"
          )
            return 0;
          if (
            !candidate.runtimeCapsule &&
            !candidate.creation &&
            bootstrap &&
            bootstrap.environment.imageRevision !== this.#imageRevision
          ) {
            const environment = await this.#stateRepository.prepareDevelopmentEnvironmentImage(
              identity,
              this.#imageRevision,
            );
            identity = { ...identity, environmentVersionId: environment.environmentVersionId };
            bootstrap = { ...bootstrap, environment };
          }
          handle =
            !candidate.runtimeCapsule && !candidate.creation && bootstrap
              ? await this.#createPhysical(bootstrap)
              : await this.#recoverPhysical(candidate);
          adopted = true;
        }
      }
      const expected = developmentEnvironmentAssignment(identity);
      if (
        handle.activationId !== identity.allocationId ||
        !sameAssignment(handle.assignment, expected)
      )
        throw new SandboxControlError(
          "persistent_machine_recovery_identity_mismatch",
          "Recovered machine allocation did not match PostgreSQL",
          false,
        );
      const inspection = await this.#provider.inspect(handle);
      if (inspection.state !== "running" && inspection.state !== "paused")
        throw new SandboxControlError(
          "cubesandbox_tool_unavailable",
          "Machine observation remains unavailable",
          true,
        );
      physicalVerified = true;
      const managed: ManagedDevelopmentEnvironment = environment ?? {
        reservation: identity,
        assignment: expected,
        handle,
        observedState: inspection.state,
        observedAt: this.#clock(),
        bindingIds: new Set(),
      };
      managed.reservation = identity;
      managed.observedState = inspection.state;
      managed.observedAt = this.#clock();
      await this.#applyDevelopmentIntent(managed);
      const restored = environment
        ? []
        : await this.#prepareRecoveredBindings(managed.handle, undefined, managed);
      await this.#stateRepository.setDevelopmentEnvironmentState(identity, "ready", {
        handle: managed.handle,
        runtimeCapsule: await this.#requiredMachineCapsule(managed.handle),
        agentActive: managed.bindingIds.size > 0,
      });
      delete managed.failure;
      delete managed.failureRecorded;
      delete managed.closureConfirmed;
      this.#developmentEnvironments.set(identity.environmentId, managed);
      for (const binding of restored) this.#toolBindings.set(binding.activationId, binding);
      this.#admission.restore(identity.allocationId, expected);
      return 1;
    } catch (error) {
      if (adopted && handle) await this.#provider.detachPersistent?.(handle).catch(() => undefined);
      if (error instanceof BindingClosurePending) return 0;
      if (physicalVerified) throw error;
      await this.#stateRepository
        .setDevelopmentEnvironmentState(identity, "reconciling", {
          failureCode: operationFailureCode(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #requiredMachineCapsule(handle: SandboxHandle): Promise<string> {
    const capsule = await this.#persistentCapsule(handle);
    if (!capsule)
      throw new SandboxControlError(
        "persistent_machine_state_unsupported",
        "Machine reconnect state is unavailable",
        true,
      );
    return capsule;
  }

  async #applyDevelopmentIntent(environment: ManagedDevelopmentEnvironment): Promise<void> {
    const identity = environment.reservation;
    const inspection = await this.#provider.inspect(environment.handle);
    if (inspection.state !== "running" && inspection.state !== "paused")
      throw new SandboxControlError(
        "cubesandbox_tool_unavailable",
        "Machine state cannot yet be confirmed",
        true,
      );
    const current = await this.#stateRepository.developmentEnvironmentOwner(
      identity.tenantId,
      identity.userId,
      identity.environmentId,
    );
    if (
      current.status !== "owned" ||
      current.reservation.allocationId !== identity.allocationId ||
      current.reservation.intentRevision !== identity.intentRevision ||
      current.reservation.desiredState !== identity.desiredState
    )
      throw new SandboxControlError(
        "development_environment_intent_changed",
        "Machine intent changed while reconciling",
        true,
      );
    environment.observedState = inspection.state;
    environment.observedAt = this.#clock();
    if (identity.desiredState === "paused" && environment.observedState === "running") {
      if (
        current.agentActive ||
        current.terminalActive ||
        environment.bindingIds.size ||
        environment.terminal
      )
        throw new SandboxControlError(
          "development_environment_agent_active",
          "Wait for active machine users before pausing",
          true,
        );
      await this.#provider.pause!(environment.handle);
      environment.observedState = "paused";
      environment.observedAt = this.#clock();
    } else if (identity.desiredState === "running" && environment.observedState === "paused") {
      environment.handle = await this.#provider.resume!(environment.handle);
      environment.observedState = "running";
      environment.observedAt = this.#clock();
    }
  }

  async #retireDevelopmentAllocation(
    identity: DevelopmentEnvironmentReservation,
    handle?: SandboxHandle,
    capsule?: string,
  ): Promise<void> {
    // Close admission first. The PG trigger revokes every old physical binding.
    await this.#stateRepository.closeAllocation(identity.allocationId, "development_environment");
    await this.#bindings.confirmPhysicalClosure(identity.allocationId);
    if (!identity.allocationAbsent)
      await this.#closePhysical(
        identity.allocationId,
        developmentEnvironmentAssignment(identity),
        "development_environment",
        handle,
        capsule,
      );
    await this.#bindings.releaseAfterPhysicalAbsence(identity.allocationId);
    if (handle) await this.#serviceRegistry?.endRuntime(handle.runtimeId);
    if (!identity.allocationAbsent)
      await this.#stateRepository.confirmDevelopmentEnvironmentAbsent(identity);
    const old = this.#developmentEnvironments.get(identity.environmentId);
    if (old?.reservation.allocationId === identity.allocationId) {
      old.terminal?.disconnect();
      for (const id of old.bindingIds) this.#revokeBinding(id);
      this.#developmentEnvironments.delete(identity.environmentId);
    }
    this.#admission.release(identity.allocationId);
  }

  developmentEnvironmentObservation(
    tenantId: string,
    userId: string,
    environmentId: string,
    allocationId: string,
  ) {
    try {
      this.#stateRepository.assertLocalOwnership();
    } catch {
      return undefined;
    }
    const environment = this.#developmentEnvironments.get(environmentId);
    if (
      !environment ||
      environment.reservation.tenantId !== tenantId ||
      environment.reservation.userId !== userId ||
      environment.reservation.allocationId !== allocationId ||
      environment.failure
    )
      return undefined;
    let state: "running" | "paused" | "unknown" = "unknown";
    try {
      const observed = this.#runtimeHealth.observation(
        this.#execution.executionIdentity(environment.handle),
      );
      if (observed && observed.at >= environment.observedAt) {
        if (
          observed.value.presence === "present" &&
          ["running", "paused"].includes(observed.value.state)
        )
          state = observed.value.state as "running" | "paused";
      } else if (this.#clock() - environment.observedAt <= 45_000)
        state = environment.observedState;
    } catch {
      /* A missing local observation cannot claim availability. */
    }
    return {
      state,
      ...(state !== "unknown" && environment.handle.ipAddress
        ? { ipAddress: environment.handle.ipAddress }
        : {}),
    };
  }

  async observeDevelopmentEnvironment(
    request: Extract<
      DevelopmentEnvironmentBrokerRequest,
      { type: "development_environment.observe" }
    >,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    const owner = await this.#stateRepository.developmentEnvironmentOwner(
      request.tenantId,
      request.userId,
      request.environmentId,
    );
    if (owner.status === "redirect") throw new SandboxOwnerRedirectError(owner.ownerBaseUrl);
    const observation =
      owner.status === "owned"
        ? this.developmentEnvironmentObservation(
            request.tenantId,
            request.userId,
            request.environmentId,
            request.allocationId,
          )
        : undefined;
    return {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.state",
      requestId: request.requestId,
      environmentId: request.environmentId,
      state: observation?.state ?? "unknown",
      ...(observation?.ipAddress ? { ipAddress: observation.ipAddress } : {}),
    };
  }

  async #prepareRecoveredBindings(
    handle: SandboxHandle,
    runtime?: ManagedElasticRuntime,
    environment?: ManagedDevelopmentEnvironment,
  ): Promise<ManagedToolBinding[]> {
    const restored: ManagedToolBinding[] = [];
    for (const route of await this.#bindings.adopt(handle.activationId)) {
      const { snapshot, descriptor, bindingId } = route;
      if (route.closed) {
        await this.#bindings.closeBinding(bindingId, snapshot.assignment, true);
        await this.#bindings.release(bindingId, snapshot.assignment);
        continue;
      }
      if (
        snapshot.physicalActivationId !== handle.activationId ||
        descriptor.target.sandboxId !== handle.runtimeName ||
        snapshot.assignment.tenantId !== handle.assignment.tenantId ||
        snapshot.assignment.workspaceId !== handle.assignment.workspaceId
      )
        throw new Error("Recovered binding does not match its physical runtime");
      const spec = {
        activationId: handle.activationId,
        assignment: snapshot.assignment,
        environment: handle.environment,
        workspaceSeed: { kind: "sample_java" as const },
        policy: this.#provider.defaultPolicy,
        toolRoot: descriptor.attachment.toolRoot,
        sandboxProfileKey: snapshot.sandboxProfileKey,
      };
      const binding: ManagedToolBinding = {
        activationId: bindingId,
        assignment: snapshot.assignment,
        turnContextSha256: snapshot.turnContextSha256,
        executionContextSha256: snapshot.executionContextSha256,
        allowedTools: new Set(snapshot.allowedTools),
        spec,
        reservation: {
          sandboxProfileKey: snapshot.sandboxProfileKey,
          activationId: handle.activationId,
          assignment: snapshot.assignment,
          turnContextSha256: snapshot.turnContextSha256,
          executionContextSha256: snapshot.executionContextSha256,
          environmentSha256: "",
          ...(snapshot.computeSessionId ? { computeSessionId: snapshot.computeSessionId } : {}),
        },
        handle,
        usedPhysicalRuntime: true,
        activeOperations: 0,
        operations: new Map(),
        ...(runtime ? { elasticRuntime: runtime } : {}),
        ...(environment ? { developmentEnvironmentId: environment.reservation.environmentId } : {}),
      };
      restored.push(binding);
    }
    for (const binding of restored) {
      runtime?.bindingIds.add(binding.activationId);
      environment?.bindingIds.add(binding.activationId);
    }
    return restored;
  }

  async #recoverElasticRuntimes(): Promise<number> {
    if (!this.#provider.adoptPersistentCapsule) return 0;
    const known = this.#localElasticRuntimes();
    const candidates = await this.#stateRepository.claimRecoverableWorkspaceRuntimes(256, [
      ...known.keys(),
    ]);
    let recovered = 0;
    for (const candidate of candidates) {
      await this.#serializeWorkspaceRuntimeProvisioning(candidate.workspace, async () => {
        // Admission may have installed a terminal/binding after the PG candidate
        // snapshot. Join its local provisioning before deciding to adopt.
        if (this.#localElasticRuntimes().has(candidate.activationId)) return;
        let handle: SandboxHandle | undefined;
        let physicalVerified = false;
        try {
          handle = await this.#recoverPhysical(candidate);
          if (
            handle.activationId !== candidate.activationId ||
            workspaceIdentityKey(handle.assignment) !== workspaceIdentityKey(candidate.workspace)
          )
            throw new Error("Recovered runtime identity changed");
          const capsule = await this.#persistentCapsule(handle);
          if (!capsule) throw new Error("Recovered runtime capsule is unavailable");
          physicalVerified = true;
          const workspaceKey =
            workspaceIdentityKey(handle.assignment) +
            (candidate.computeSessionId ? `:compute:${candidate.computeSessionId}` : "");
          const runtime: ManagedElasticRuntime = {
            capsuleStored: true,
            physicalActivationId: candidate.activationId,
            workspaceKey,
            handle,
            spec: {
              activationId: candidate.activationId,
              assignment: handle.assignment,
              environment: handle.environment,
              workspaceSeed: { kind: "sample_java" },
              policy: this.#provider.defaultPolicy,
              toolRoot: handle.workspaceRoot,
              sandboxProfileKey: candidate.sandboxProfileKey,
            },
            bindingIds: new Set(),
            activeOperations: 0,
            environment: handle.environment,
            sandboxProfileKey: candidate.sandboxProfileKey,
          };
          const restored = await this.#prepareRecoveredBindings(handle, runtime);
          await this.#stateRepository.setWorkspaceRuntimeState(
            candidate.activationId,
            "allocated",
            { handle, runtimeCapsule: capsule },
          );
          for (const binding of restored) this.#toolBindings.set(binding.activationId, binding);
          if (!runtime.bindingIds.size) this.#warm.set(workspaceKey, runtime);
          this.#admission.restore(candidate.activationId, handle.assignment);
          recovered++;
        } catch (error) {
          if (handle) await this.#provider.detachPersistent?.(handle).catch(() => {});
          if (error instanceof BindingClosurePending) return;
          if (physicalVerified) {
            this.#onMaintenanceError?.(error);
            return;
          }
          if (error instanceof SandboxCreationError && error.absenceConfirmed) {
            await this.#stateRepository.closeAllocation(candidate.activationId, "workspace");
            await this.#bindings.releaseAfterPhysicalAbsence(candidate.activationId);
            if (candidate.runtimeId) await this.#serviceRegistry?.endRuntime(candidate.runtimeId);
            await this.#stateRepository.setWorkspaceRuntimeState(
              candidate.activationId,
              "released",
            );
            this.#admission.release(candidate.activationId);
            return;
          }
          await this.#stateRepository.setWorkspaceRuntimeState(candidate.activationId, "unknown", {
            ...(candidate.runtimeCapsule ? { runtimeCapsule: candidate.runtimeCapsule } : {}),
            failureCode: "runtime_recovery_unconfirmed",
            ...(handle ? { handle } : {}),
          });
        }
      });
    }
    return recovered;
  }

  /** These are holders of the same objects, not independent runtime owners. */
  #localElasticRuntimes(): Map<string, ManagedElasticRuntime> {
    const runtimes = new Map<string, ManagedElasticRuntime>();
    const add = (runtime: ManagedElasticRuntime | undefined) => {
      if (runtime) runtimes.set(runtime.physicalActivationId, runtime);
    };
    for (const runtime of this.#warm.values()) add(runtime);
    for (const binding of this.#toolBindings.values()) add(binding.elasticRuntime);
    for (const terminal of this.#terminals.values()) add(terminal.workspaceRuntime);
    return runtimes;
  }

  get warmCount(): number {
    return this.#warm.size;
  }

  get cleanPrewarmCount(): number {
    return this.#provider.cleanPrewarmCount ?? 0;
  }

  async checkHealth(): Promise<void> {
    // Workspace storage can serve persistent files even while the Cube control plane is
    // unavailable. Cube validates execution readiness during actual creation.
    await this.#stateRepository.checkHealth();
  }

  async provisionDevelopmentEnvironment(
    request: DevelopmentEnvironmentProvisionRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    return this.#serializeWorkspaceRuntimeProvisioning(
      developmentEnvironmentAssignment(request),
      () => this.#provisionDevelopmentEnvironment(request),
    );
  }

  async #provisionDevelopmentEnvironment(
    request: DevelopmentEnvironmentProvisionRequest,
  ): Promise<DevelopmentEnvironmentBrokerResponse> {
    if (
      this.#terminalsProvider.openTerminal === undefined ||
      this.#provider.pause === undefined ||
      this.#provider.resume === undefined ||
      this.#provider.persistentCapsule === undefined ||
      this.#provider.adoptPersistentCapsule === undefined ||
      this.#provider.detachPersistent === undefined
    ) {
      throw new SandboxControlError(
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
        throw new SandboxControlError(
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
        state: existing.observedState,
        ...(existing.handle.ipAddress === undefined
          ? {}
          : { ipAddress: existing.handle.ipAddress }),
      };
    }
    const reservation: DevelopmentEnvironmentReservation = {
      environmentId: request.environmentId,
      allocationId: request.allocationId,
      intentRevision: request.intentRevision,
      desiredState: "running",
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
      throw new SandboxOwnerRedirectError(reserved.ownerBaseUrl);
    }
    if (reserved.status === "busy") {
      throw new SandboxControlError(
        "development_environment_workspace_busy",
        "Workspace is already owned by another execution environment",
        true,
      );
    }
    if (reserved.status === "capacity") {
      throw new SandboxControlError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    const assignment = developmentEnvironmentAssignment(request);
    let handle: SandboxHandle | undefined;
    let admitted = false;
    try {
      await this.#admission.acquire(request.allocationId, assignment);
      admitted = true;
      handle = await this.#createPhysical({
        activationId: request.allocationId,
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
          request.allocationId,
          assignment,
          request.environment,
          DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
        )
      ) {
        throw new SandboxControlError(
          "sandbox_provider_protocol_error",
          "Sandbox Provider returned a mismatched development environment handle",
          false,
        );
      }
      const runtimeCapsule = await this.#persistentCapsule(handle);
      await this.#stateRepository.setDevelopmentEnvironmentState(reservation, "ready", {
        handle,
        ...(runtimeCapsule === undefined ? {} : { runtimeCapsule }),
      });
      this.#developmentEnvironments.set(request.environmentId, {
        reservation,
        observedState: "running",
        observedAt: this.#clock(),
        assignment,
        handle,
        bindingIds: new Set(),
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
      let absent = !admitted || (error instanceof SandboxCreationError && error.absenceConfirmed);
      if (handle !== undefined) {
        try {
          await this.#closePhysical(
            request.allocationId,
            assignment,
            "development_environment",
            handle,
          );
          absent = true;
        } catch {
          absent = false;
        }
      }
      if (admitted && absent) this.#admission.release(request.allocationId);
      const capsule =
        !absent && handle
          ? await this.#persistentCapsule(handle).catch(() => undefined)
          : undefined;
      await this.#stateRepository
        .setDevelopmentEnvironmentState(reservation, absent ? "failed" : "reconciling", {
          failureCode: operationFailureCode(error),
          ...(!absent && handle ? { handle } : {}),
          ...(capsule ? { runtimeCapsule: capsule } : {}),
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
    if (ownership.status === "redirect")
      throw new SandboxOwnerRedirectError(ownership.ownerBaseUrl);
    if (ownership.status !== "owned")
      throw new SandboxControlError(
        "development_environment_unavailable",
        "Machine ownership is unavailable",
        true,
      );
    return this.#serializeWorkspaceRuntimeProvisioning(
      developmentEnvironmentAssignment(ownership.reservation),
      async () => {
        const current = await this.#stateRepository.developmentEnvironmentOwner(
          request.tenantId,
          request.userId,
          request.environmentId,
        );
        const desired =
          request.action === "pause"
            ? "paused"
            : request.action === "resume"
              ? "running"
              : "released";
        if (
          current.status !== "owned" ||
          current.reservation.intentRevision !== request.intentRevision ||
          current.reservation.desiredState !== desired
        )
          throw new SandboxControlError(
            "development_environment_intent_changed",
            "Machine request has been superseded",
            true,
          );
        const identity = current.reservation;
        const environment = this.#developmentEnvironments.get(request.environmentId);
        if (
          current.agentActive ||
          current.terminalActive ||
          environment?.bindingIds.size ||
          environment?.terminal
        )
          throw new SandboxControlError(
            "development_environment_agent_active",
            "Wait for active machine users before changing its lifecycle",
            true,
          );
        let state: "running" | "paused" | "released" | "unknown" = "unknown";
        if (desired === "released") {
          await this.#retireDevelopmentAllocation(identity, environment?.handle);
          await this.#stateRepository.setDevelopmentEnvironmentState(identity, "released");
          state = "released";
        } else if (
          environment &&
          !environment.failure &&
          environment.reservation.allocationId === identity.allocationId
        ) {
          environment.reservation = identity;
          await this.#applyDevelopmentIntent(environment);
          await this.#stateRepository.setDevelopmentEnvironmentState(identity, "ready", {
            handle: environment.handle,
            runtimeCapsule: await this.#requiredMachineCapsule(environment.handle),
          });
          state = environment.observedState;
        }
        return {
          developmentEnvironmentProtocolVersion: 1,
          type: "development_environment.state",
          requestId: request.requestId,
          environmentId: request.environmentId,
          state,
        };
      },
    );
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
        this.#files.listDirectory === undefined) ||
      (request.type === "development_environment.create_directory" &&
        this.#files.createDirectory === undefined)
    ) {
      throw new SandboxControlError(
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
      throw new SandboxOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(request.environmentId);
    if (
      ownership.status !== "owned" ||
      ownership.state !== "ready" ||
      ownership.reservation.desiredState !== "running" ||
      environment === undefined
    ) {
      throw new SandboxControlError(
        "development_environment_directory_unavailable",
        "Exclusive machine is not running on its owning Sandbox control",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== request.tenantId ||
      environment.reservation.userId !== request.userId
    ) {
      throw new SandboxControlError(
        "development_environment_unauthorized",
        "Exclusive machine ownership did not match",
        false,
      );
    }
    const directory =
      request.type === "development_environment.create_directory"
        ? await this.#files.createDirectory!(environment.handle, request.path, request.name)
        : await this.#files.listDirectory!(environment.handle, request.path);
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
    if (this.#terminalsProvider.openTerminal === undefined) {
      throw new SandboxControlError(
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
      throw new SandboxOwnerRedirectError(ownership.ownerBaseUrl);
    }
    const environment = this.#developmentEnvironments.get(input.environmentId);
    if (
      ownership.status !== "owned" ||
      ownership.state !== "ready" ||
      ownership.reservation.desiredState !== "running" ||
      environment === undefined
    ) {
      throw new SandboxControlError(
        "development_environment_terminal_unavailable",
        "Development environment must be running before opening a terminal",
        true,
      );
    }
    if (
      environment.reservation.tenantId !== input.tenantId ||
      environment.reservation.userId !== input.userId
    ) {
      throw new SandboxControlError(
        "development_environment_unauthorized",
        "Development environment ownership did not match",
        false,
      );
    }
    if (environment.terminal !== undefined) {
      throw new SandboxControlError(
        "development_environment_terminal_busy",
        "Development environment already has an active terminal",
        true,
      );
    }
    const allocationId = environment.reservation.allocationId;
    if (
      !(await this.#stateRepository.reserveDevelopmentEnvironmentTerminal(
        input.environmentId,
        allocationId,
      ))
    ) {
      throw new SandboxControlError(
        "development_environment_terminal_busy",
        "Development environment already has an active terminal",
        true,
      );
    }
    const terminalHandle = environment.handle;
    let terminal: SandboxTerminalSession;
    try {
      terminal = await this.#terminalsProvider.openTerminal(terminalHandle, {
        rows: input.rows,
        cols: input.cols,
      });
    } catch (error: unknown) {
      await this.#stateRepository
        .releaseDevelopmentEnvironmentTerminal(input.environmentId, allocationId)
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
          .releaseDevelopmentEnvironmentTerminal(input.environmentId, allocationId)
          .catch(() => undefined);
      },
    });
  }

  async openTerminal(input: WorkspaceTerminalOpenInput): Promise<WorkspaceTerminalConnection> {
    return this.#serializeWorkspaceRuntimeProvisioning(input, () => this.#openTerminal(input));
  }

  async #openTerminal(input: WorkspaceTerminalOpenInput): Promise<WorkspaceTerminalConnection> {
    if (this.#terminalsProvider.openTerminal === undefined) {
      throw new SandboxControlError(
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
      throw new SandboxControlError(
        "environment_policy_mismatch",
        "Workspace environment is not served by this Sandbox control",
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
      throw new SandboxOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new SandboxControlError(
        "workspace_terminal_busy",
        "Workspace already has an active human terminal",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new SandboxControlError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    const assignment = terminalAssignment(terminalId, input, reservation.executionReference);
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
        throw new SandboxControlError(
          "workspace_runtime_unavailable",
          "Workspace runtime is not attached to its owning Sandbox control",
          true,
        );
      }
      await this.#stateRepository.setTerminalState(terminalId, "materializing");
      if (workspaceRuntime === undefined) {
        await this.#admission.acquire(terminalId, assignment);
        admitted = true;
        handle = await this.#createPhysical(
          {
            activationId: terminalId,
            assignment,
            environment: input.environment,
            workspaceSeed: input.workspaceSeed,
            policy: this.#provider.defaultPolicy,
            toolRoot: "/workspace",
          },
          "terminal",
        );
      } else {
        this.#warm.delete(workspaceRuntime.workspaceKey);
        handle = await this.#materializeElasticRuntime(workspaceRuntime);
        workspaceRuntime.workspaceTerminalId = terminalId;
      }
      if (handle === undefined) {
        throw new SandboxControlError(
          "workspace_terminal_runtime_unavailable",
          "Workspace terminal runtime was unavailable",
          true,
        );
      }
      terminal = await this.#terminalsProvider.openTerminal(handle, input.size);
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
          this.#warm.set(workspaceRuntime.workspaceKey, workspaceRuntime);
        }
      } else {
        let absent = !admitted;
        try {
          await this.#closePhysical(terminalId, assignment, "terminal", handle);
          absent = true;
        } catch {
          /* Retain uncertain allocation and capacity. */
        }
        if (admitted && absent) this.#admission.release(terminalId);
      }
      await this.#stateRepository
        .setTerminalState(terminalId, "unknown", { failureCode: operationFailureCode(error) })
        .catch(() => undefined);
      throw error;
    }
  }

  async #previewHandle(
    request: Pick<SandboxPreviewConnectionRequest, "tenantId" | "userId" | "target">,
  ): Promise<SandboxHandle> {
    const ownership = await this.#stateRepository.sandboxPreviewOwner(
      request.tenantId,
      request.userId,
      request.target,
    );
    if (ownership.status === "redirect") {
      throw new SandboxOwnerRedirectError(ownership.ownerBaseUrl);
    }
    if (ownership.status === "unavailable") {
      throw new SandboxControlError(
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
      throw new SandboxControlError(
        "sandbox_preview_unavailable",
        "Sandbox preview target has no live runtime",
        true,
      );
    }
    return handle;
  }

  async openPreviewConnection(
    request: SandboxPreviewConnectionRequest,
    signal?: AbortSignal,
  ): Promise<import("node:stream").Duplex> {
    signal?.throwIfAborted();
    const handle = await this.#previewHandle(request);
    signal?.throwIfAborted();
    if (handle.assignment.workspaceId !== request.workspaceId)
      throw new SandboxControlError(
        "sandbox_preview_binding_changed",
        "Application workspace changed",
        false,
      );
    if (this.#previews.openPreviewConnection === undefined)
      throw new SandboxControlError(
        "sandbox_preview_unsupported",
        "Application connections are unavailable",
        false,
      );
    return this.#previews.openPreviewConnection(handle, request.port, signal);
  }

  async create(
    request: ToolSandboxCreateRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxCreateResponse> {
    if (!this.#controlReady())
      throw new SandboxControlError(
        "workspace_runtime_unavailable",
        "Sandbox control is starting",
        true,
      );
    this.#stateRepository.assertLocalOwnership();
    this.#assertCreateEnvironment(request);
    return this.#serializeWorkspaceRuntimeProvisioning(request.assignment, async () => {
      signal?.throwIfAborted();
      const response =
        request.executionMode === "elastic" || request.computeSessionId !== undefined
          ? await this.#createElasticBinding(request)
          : await this.#createDevelopmentEnvironmentBinding(request);
      const activation = this.#toolBindings.get(response.activationId)!;
      try {
        const handle = await this.#materialize(activation, signal);
        signal?.throwIfAborted();
        const descriptor = await this.#execution.describeExecution(
          handle,
          response.activationId,
          request.toolRoot,
        );
        await this.#bindings.register(response.activationId, descriptor, {
          assignment: request.assignment,
          physicalActivationId: activation.reservation.activationId,
          turnContextSha256: request.turnContextSha256,
          executionContextSha256: request.executionContextSha256,
          allowedTools: [...activation.allowedTools],
          sandboxProfileKey: request.sandboxProfileKey,
          ...(activation.developmentEnvironmentId
            ? { developmentEnvironmentId: activation.developmentEnvironmentId }
            : {}),
          ...(request.computeSessionId ? { computeSessionId: request.computeSessionId } : {}),
        });
        signal?.throwIfAborted();
        return response;
      } catch (error) {
        const runtime = activation.elasticRuntime;
        if (runtime?.handle || activation.handle) {
          await this.#releaseActivation({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId: request.requestId,
            activationId: activation.activationId,
            assignment: activation.assignment,
            disposition: runtime ? "keep_warm" : "detach",
          }).catch((failure) => this.#onMaintenanceError?.(failure));
        } else {
          this.#revokeBinding(activation.activationId);
          runtime?.bindingIds.delete(activation.activationId);
        }
        throw error;
      }
    });
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
      throw new SandboxControlError(
        "environment_policy_mismatch",
        "Run environment is not served by this Sandbox control",
        false,
      );
    }
  }

  async #createElasticBinding(
    request: ToolSandboxCreateRequest,
  ): Promise<ToolSandboxCreateResponse> {
    const workspaceKey =
      workspaceIdentityKey(request.assignment) +
      (request.computeSessionId ? `:compute:${request.computeSessionId}` : "");
    if (
      request.computeSessionId === undefined &&
      [...this.#developmentEnvironments.values()].some(
        (environment) =>
          environment.reservation.tenantId === request.assignment.tenantId &&
          environment.reservation.workspaceId === request.assignment.workspaceId,
      )
    ) {
      throw new SandboxControlError(
        "development_environment_execution_mode_mismatch",
        "Machine-owned Workspace requires development-environment execution mode",
        false,
      );
    }
    let runtime = [...this.#toolBindings.values()].find(
      (activation) => activation.elasticRuntime?.workspaceKey === workspaceKey,
    )?.elasticRuntime;
    runtime ??= this.#warm.get(workspaceKey);
    const workspaceTerminal =
      request.computeSessionId !== undefined
        ? undefined
        : [...this.#terminals.entries()].find(
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
      if (runtime.bindingIds.size > 0 || runtime.workspaceTerminalId !== undefined) {
        throw new SandboxControlError(
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
          policy: this.#provider.defaultPolicy,
          toolRoot: request.toolRoot,
          volumeMountPath:
            request.executionMode === "development_environment" ? "/home/user" : "/workspace",
          sandboxProfileKey: request.sandboxProfileKey,
        },
        ...(workspaceTerminal === undefined ? {} : { handle: workspaceTerminal[1].handle }),
        bindingIds: new Set(),
        activeOperations: 0,
        environment: request.environment,
        sandboxProfileKey: request.sandboxProfileKey,
        ...(workspaceTerminal === undefined ? {} : { workspaceTerminalId: workspaceTerminal[0] }),
      };
      if (workspaceTerminal !== undefined) workspaceTerminal[1].workspaceRuntime = runtime;
    }

    const activationId = validActivationId(request.requestId);
    if (this.#toolBindings.has(activationId) || runtime.bindingIds.has(activationId)) {
      throw new SandboxControlError(
        "tool_binding_identity_collision",
        "Tool binding identity collided",
        false,
      );
    }
    const allowedTools = parseCloudToolCapabilitySnapshot(request.allowedTools);
    const reservationInput: WorkspaceRuntimeReservation = {
      sandboxProfileKey: request.sandboxProfileKey,
      activationId: runtime.physicalActivationId,
      ...(request.computeSessionId === undefined
        ? {}
        : { computeSessionId: request.computeSessionId }),
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      executionContextSha256: request.executionContextSha256,
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
    };
    const reservation = await this.#stateRepository.reserve(reservationInput);
    if (reservation.status === "redirect") {
      throw new SandboxOwnerRedirectError(reservation.ownerBaseUrl);
    }
    if (reservation.status === "busy") {
      throw new SandboxControlError(
        "workspace_runtime_busy",
        "Workspace runtime is temporarily unavailable",
        true,
      );
    }
    if (reservation.status === "capacity") {
      throw new SandboxControlError(
        "sandbox_domain_capacity_exhausted",
        "Sandbox Domain has reached its active Sandbox limit",
        true,
      );
    }
    if (reservation.status === "development_environment") {
      throw new SandboxControlError(
        "elastic_execution_mode_mismatch",
        "Elastic Workspace unexpectedly resolved to a development environment",
        false,
      );
    }
    runtime.bindingIds.add(activationId);
    this.#toolBindings.set(activationId, {
      activationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      executionContextSha256: request.executionContextSha256,
      allowedTools: new Set(allowedTools),
      spec: { ...runtime.spec, assignment: request.assignment, toolRoot: request.toolRoot },
      reservation: reservationInput,
      elasticRuntime: runtime,
      usedPhysicalRuntime: false,
      activeOperations: 0,
      operations: new Map(),
    });
    if (runtime.handle !== undefined) {
      const capsule = runtime.capsuleStored
        ? undefined
        : await this.#persistentCapsule(runtime.handle);
      if (!runtime.capsuleStored && !capsule)
        throw new Error("Runtime recovery capsule is unavailable");
      if (capsule)
        await this.#stateRepository.setWorkspaceRuntimeState(
          runtime.physicalActivationId,
          "allocated",
          {
            handle: runtime.handle,
            runtimeCapsule: capsule,
          },
        );
      runtime.capsuleStored = true;
    }
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      executionReference: request.assignment.executionReference,
      ownerBaseUrl: this.#ownerBaseUrl,
      workspaceRoot: request.toolRoot,
      continuity: runtime.handle === undefined ? "cold_restore" : "warm_reuse",
      // This allocation identity exists before materialization and survives
      // warm reuse. Switching to the provider's runtime UUID on the next Run
      // would falsely report a reset of the very same Cube.
      continuityId: runtime.physicalActivationId,
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
      throw new SandboxControlError(
        "elastic_execution_mode_mismatch",
        "Development-environment execution requires an owned machine",
        false,
      );
    }
    if (environment.reservation.profileKey !== request.sandboxProfileKey) {
      throw new SandboxControlError(
        "development_environment_profile_mismatch",
        "Conversation Sandbox profile does not match its exclusive environment",
        false,
      );
    }
    if (environment.failure !== undefined) throw environment.failure;
    let continuityId: string;
    try {
      ({ continuityId } = await this.#verifyDevelopmentEnvironment(environment));
    } catch (error) {
      await this.#quarantineDevelopmentEnvironment(environment, error);
      throw error;
    }
    const physicalActivationId = validActivationId(environment.reservation.allocationId);
    const activationId = validActivationId(request.requestId);
    if (this.#toolBindings.has(activationId) || environment.bindingIds.has(activationId)) {
      throw new SandboxControlError(
        "tool_binding_identity_collision",
        "Tool binding identity collided",
        false,
      );
    }
    const reservationInput: WorkspaceRuntimeReservation = {
      sandboxProfileKey: request.sandboxProfileKey,
      activationId: physicalActivationId,
      assignment: request.assignment,
      turnContextSha256: request.turnContextSha256,
      executionContextSha256: request.executionContextSha256,
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
    };
    const reservation = await this.#stateRepository.reserve(reservationInput);
    if (reservation.status === "redirect")
      throw new SandboxOwnerRedirectError(reservation.ownerBaseUrl);
    if (
      reservation.status !== "development_environment" ||
      reservation.environmentId !== environment.reservation.environmentId
    ) {
      throw new SandboxControlError(
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
      executionContextSha256: request.executionContextSha256,
      allowedTools: new Set(parseCloudToolCapabilitySnapshot(request.allowedTools)),
      spec: {
        activationId: physicalActivationId,
        assignment: request.assignment,
        environment: request.environment,
        workspaceSeed: request.workspaceSeed,
        policy: this.#provider.defaultPolicy,
        toolRoot: request.toolRoot,
        sandboxProfileKey: request.sandboxProfileKey,
      },
      reservation: reservationInput,
      handle: environment.handle,
      usedPhysicalRuntime: false,
      activeOperations: 0,
      operations: new Map(),

      developmentEnvironmentId: environment.reservation.environmentId,
    });
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.reserved",
      requestId: request.requestId,
      activationId,
      executionReference: request.assignment.executionReference,
      ownerBaseUrl: this.#ownerBaseUrl,
      workspaceRoot: request.toolRoot,
      continuity: "warm_reuse",
      continuityId,
    };
  }

  async executeWorkflow(
    executionReference: string,
    request: Extract<ToolSandboxOperationRequest, { operation: "workflow.exec" }>,
    signal?: AbortSignal,
    onUpdate?: (event: NativeToolUpdate) => Promise<void>,
  ): Promise<ToolSandboxOperationResponse> {
    if (request.operation !== "workflow.exec")
      throw new Error("Fixed Tools require native Cube handoff");
    const activation = this.#authorizedBinding(request.activationId, executionReference);
    const elasticRuntime = activation.elasticRuntime;
    if (!activation.allowedTools.has(request.toolName)) {
      throw new SandboxControlError(
        "tool_not_granted",
        "Tool is not present in this Run capability snapshot",
        false,
      );
    }
    if (!TOOL_OPERATIONS[request.toolName].has(request.operation)) {
      throw new SandboxControlError(
        "tool_operation_not_granted",
        "Tool operation does not match its granted Tool",
        false,
      );
    }
    if (request.turnContextSha256 !== activation.turnContextSha256) {
      throw new SandboxControlError(
        "turn_context_mismatch",
        "Tool operation did not match the frozen Cloud Turn context",
        false,
      );
    }
    if (request.executionContextSha256 !== activation.executionContextSha256) {
      throw new SandboxControlError(
        "execution_context_mismatch",
        "Tool operation did not match the current Cloud execution context",
        false,
      );
    }
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify(request), "utf8")
      .digest("hex");
    const existing = activation.operations.get(request.operationId);
    if (existing !== undefined) {
      if (existing.requestSha256 === requestSha256)
        return existing.result as Promise<ToolSandboxOperationResponse>;
      throw new SandboxControlError(
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
      throw new SandboxControlError(
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
        const handle = await this.#materialize(activation, operationSignal);
        let response: ToolSandboxOperationResponse;
        try {
          {
            if (!this.#workflows.openWorkflow)
              throw new SandboxControlError(
                "workflow_unavailable",
                "Isolated workflow execution is unavailable",
                false,
              );
            const stream = await this.#workflows.openWorkflow(handle, {
              script: request.script,
              operationId: request.operationId,
              cwd: activation.spec.toolRoot ?? handle.workspaceRoot,
            });
            try {
              response = await this.#workflowChannels.run(
                request,
                stream,
                operationSignal,
                async (value) => {
                  await onUpdate?.({
                    type: "tool_execution_update",
                    toolCallId: request.toolCallId,
                    toolName: request.toolName,
                    args: { script: request.script },
                    partialResult: {
                      content: [
                        {
                          type: "text",
                          text: typeof value === "string" ? value : JSON.stringify(value),
                        },
                      ],
                      details: {},
                    },
                  });
                },
              );
            } catch (error) {
              throw new SandboxControlError(
                "workflow_result_unknown",
                "Workflow ended without a confirmed result; inspect effects before retrying",
                false,
                error,
              );
            }
          }
        } catch (error: unknown) {
          throw error;
        }
        return response;
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
    // Only running operations belong here (cancellation and concurrent dedup).
    // Completed results belong to Kafka. Do not retain them in the Broker.
    const forget = () => activation.operations.delete(request.operationId);
    void durable.then(forget, forget);
    return durable;
  }

  async imageIo(request: ToolImageRequest, signal?: AbortSignal): Promise<ToolImageResponse> {
    if (!this.#inputImages || !this.#images.imageIo)
      throw new SandboxControlError(
        "tool_image_io_unavailable",
        "Tool image I/O is unavailable",
        false,
      );
    const activation = this.#ownedBinding(request.activationId, request.assignment);
    if (activation.inputClosed)
      throw new SandboxControlError("tool_binding_closed", "Tool binding is closing", false);
    const key = `image:${request.requestId}`;
    const requestSha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = activation.operations.get(key);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) throw new Error("Tool image identity conflict");
      return existing.result as Promise<ToolImageResponse>;
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const queued = new AbortController();
    const abortQueued = () => queued.abort(combined.reason);
    combined.addEventListener("abort", abortQueued, { once: true });
    if (combined.aborted) abortQueued();
    const waiting = setTimeout(
      () => controller.abort(new Error("Tool image preparation queue timed out")),
      30_000,
    );
    waiting.unref();
    const result = this.#inputPreparation
      .add(
        async (): Promise<ToolImageResponse> => {
          clearTimeout(waiting);
          combined.removeEventListener("abort", abortQueued);
          // Running I/O remains tracked until the guest actually returns, even when
          // its caller cancels. Reuse the existing image decode admission slot.
          activation.activeOperations++;
          if (activation.elasticRuntime) activation.elasticRuntime.activeOperations++;
          try {
            combined.throwIfAborted();
            const handle = await this.#materialize(activation, combined);
            const base = {
              cwd: activation.spec.toolRoot ?? handle.workspaceRoot,
              operationId: request.operationId,
            };
            this.#stateRepository.assertLocalOwnership();
            const prepared =
              request.action.kind === "read"
                ? await this.#images.imageIo!(
                    handle,
                    { ...base, kind: "read", path: request.action.path },
                    combined,
                  )
                : await this.#inputImages!.withStream(
                    request.assignment.tenantId,
                    request.action.source,
                    (chunks, sourceSignal) =>
                      this.#images.imageIo!(
                        handle,
                        {
                          ...base,
                          kind: "save",
                          chunks,
                          byteLength:
                            request.action.kind === "save" ? request.action.source.byteLength : 0,
                        },
                        sourceSignal,
                      ),
                    combined,
                  );
            combined.throwIfAborted();
            const bytes = Buffer.from(prepared.data, "base64");
            if (!bytes.length || bytes.toString("base64") !== prepared.data)
              throw new Error("Invalid prepared Tool image");
            const image = await this.#inputImages!.put(
              { tenantId: request.assignment.tenantId, runId: request.assignment.runId },
              bytes,
              "image/png",
              combined,
            );
            return {
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.image_io_result",
              requestId: request.requestId,
              activationId: request.activationId,
              image,
              ...(prepared.path ? { path: prepared.path } : {}),
              ...(prepared.placementError ? { placementError: prepared.placementError } : {}),
            };
          } finally {
            activation.activeOperations--;
            if (activation.elasticRuntime) activation.elasticRuntime.activeOperations--;
          }
        },
        { signal: queued.signal },
      )
      .then((value) => {
        if (!value) throw new Error("Tool image preparation did not complete");
        return value;
      })
      .finally(() => {
        clearTimeout(waiting);
        combined.removeEventListener("abort", abortQueued);
      });
    activation.operations.set(key, {
      requestSha256,
      result,
      controller,
    });
    void result.then(
      () => activation.operations.delete(key),
      () => activation.operations.delete(key),
    );
    return result;
  }

  async prepareInputImages(
    request: InputImageRequest,
    signal?: AbortSignal,
  ): Promise<InputImageResponse> {
    if (!this.#inputImages || !this.#images.prepareInputImage)
      throw new SandboxControlError(
        "input_images_unavailable",
        "Input image preparation is unavailable",
        false,
      );
    const activation = this.#ownedBinding(request.activationId, request.assignment);
    if (activation.inputClosed)
      throw new SandboxControlError(
        "steer_target_unavailable",
        "Tool binding is closing input preparation",
        false,
      );
    const key = `input:${request.requestId}`,
      requestSha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = activation.operations.get(key);
    if (existing) {
      if (existing.requestSha256 !== requestSha256)
        throw new Error("Input preparation identity conflict");
      return existing.result as Promise<InputImageResponse>;
    }
    if (this.#inputPreparation.size >= 8)
      throw new SandboxControlError(
        "input_image_capacity_exhausted",
        "Input image preparation is busy",
        true,
      );
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    // Cancel a queued slot promptly, but retain the in-flight operation until
    // the guest actually stops; p-queue's running signal rejects before cleanup.
    const queued = new AbortController();
    const abortQueued = () => queued.abort(combined.reason);
    combined.addEventListener("abort", abortQueued, { once: true });
    if (combined.aborted) abortQueued();
    const waiting = setTimeout(
      () => controller.abort(new Error("Input image preparation queue timed out")),
      30_000,
    );
    waiting.unref();
    const result = this.#inputPreparation
      .add(
        async (): Promise<InputImageResponse> => {
          clearTimeout(waiting);
          combined.removeEventListener("abort", abortQueued);
          combined.throwIfAborted();
          activation.activeOperations++;
          const runtime = activation.elasticRuntime;
          if (runtime) runtime.activeOperations++;
          try {
            const handle = await this.#materialize(activation, combined);
            const images: InputImageResponse["images"] = [];
            for (const source of request.images) {
              combined.throwIfAborted();
              this.#stateRepository.assertLocalOwnership();
              const prepared = await this.#inputImages!.withStream(
                activation.assignment.tenantId,
                source,
                (chunks, signal) =>
                  this.#images.prepareInputImage!(
                    handle,
                    {
                      chunks,
                      byteLength: source.byteLength,
                      mimeType: source.mimeType,
                    },
                    signal,
                  ),
                combined,
              );
              const decoded = Buffer.from(prepared.data, "base64");
              if (!decoded.length || decoded.toString("base64") !== prepared.data)
                throw new SandboxControlError(
                  "input_images_too_large",
                  "Prepared input images exceed their combined size limit",
                  false,
                );
              const image =
                prepared.mimeType === source.mimeType &&
                decoded.length === source.byteLength &&
                createHash("sha256").update(decoded).digest("hex") === source.sha256
                  ? source
                  : await this.#inputImages!.put(
                      {
                        tenantId: activation.assignment.tenantId,
                        runId: activation.assignment.runId,
                      },
                      decoded,
                      prepared.mimeType,
                      combined,
                    );
              images.push({ sourceId: source.id, image, hints: [...prepared.hints] });
            }
            combined.throwIfAborted();
            return {
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.input_images_prepared",
              requestId: request.requestId,
              activationId: request.activationId,
              images,
            };
          } finally {
            activation.activeOperations--;
            if (runtime) runtime.activeOperations--;
          }
        },
        { signal: queued.signal },
      )
      .then((value) => {
        if (!value) throw new Error("Input image preparation did not complete");
        return value;
      })
      .finally(() => {
        clearTimeout(waiting);
        combined.removeEventListener("abort", abortQueued);
      });
    activation.operations.set(key, { requestSha256, result, controller });
    void result.then(
      () => activation.operations.delete(key),
      () => activation.operations.delete(key),
    );
    return result;
  }

  async stopWorkflowScope(
    fact: import("./workflow-command-dispatcher.ts").ToolLogFact,
  ): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const activation of this.#toolBindings.values()) {
      const identity = parseExecutionReference(activation.assignment.executionReference);
      if (
        identity.leaseId !== fact.scope.writerId ||
        (fact.kind === "binding_close" && activation.activationId !== fact.bindingId)
      )
        continue;
      for (const [key, operation] of activation.operations) {
        if (key.startsWith("input:")) continue;
        operation.controller.abort();
        pending.push(operation.result);
      }
    }
    await Promise.allSettled(pending);
  }

  async quarantineExecutionTarget(target: SandboxExecutionTarget): Promise<void> {
    const failure = new SandboxControlError(
      "cubesandbox_tool_unavailable",
      "Recorded execution target is unavailable; control-plane recovery is required",
      false,
    );
    const runtimes = new Set([
      ...this.#warm.values(),
      ...[...this.#toolBindings.values()].flatMap((binding) =>
        binding.elasticRuntime ? [binding.elasticRuntime] : [],
      ),
    ]);
    for (const runtime of runtimes) {
      if (runtime.handle?.runtimeName !== target.sandboxId) continue;
      const descriptor = await this.#execution.describeExecution(
        runtime.handle,
        runtime.physicalActivationId,
        runtime.handle.workspaceRoot,
      );
      if (descriptor.target.bootId === target.bootId)
        await this.#markElasticRuntimeLost(runtime, failure);
    }
    for (const environment of this.#developmentEnvironments.values()) {
      if (environment.handle.runtimeName === target.sandboxId)
        await this.#quarantineDevelopmentEnvironment(environment, failure);
    }
  }

  ownsToolBinding(activationId: string): boolean {
    return this.#toolBindings.has(activationId);
  }

  async attachWorkflow(
    activationId: string,
    operationId: string,
    executionReference: string,
    send: (frame: WorkflowFrame) => void,
    signal: AbortSignal,
  ) {
    this.#authorizedBinding(activationId, executionReference);
    return this.#workflowChannels.attach(activationId, operationId, send, signal);
  }

  async refreshServices(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#ownedBinding(activationId, assignment);
    if (this.#previews.discoverHttpServices === undefined)
      throw new SandboxControlError(
        "service_discovery_unavailable",
        "Service discovery is unavailable",
        false,
      );
    const handle = await this.#materialize(activation);
    const discovery = await this.#previews.discoverHttpServices(handle);
    await this.#observeHttpServices(activation, handle, randomUUID(), discovery);
  }

  async release(request: ToolSandboxReleaseRequest): Promise<ToolSandboxReleaseResponse> {
    return this.#releaseActivation(request);
  }

  async #releaseActivation(
    request: ToolSandboxReleaseRequest,
  ): Promise<ToolSandboxReleaseResponse> {
    if (!this.#toolBindings.has(request.activationId)) {
      await this.#releaseDetachedBinding(
        request.activationId,
        request.assignment,
        request.cancelOutstanding === true,
      );
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: false,
      };
    }
    const activation = this.#ownedBinding(request.activationId, request.assignment);
    if (
      (activation.elasticRuntime && request.disposition === "detach") ||
      (!activation.elasticRuntime && request.disposition !== "detach")
    )
      throw new SandboxControlError(
        "tool_binding_identity_mismatch",
        "Release disposition did not match its runtime",
        false,
      );
    activation.inputClosed = true;
    await this.#bindings.closeBinding(
      activation.activationId,
      activation.assignment,
      request.cancelOutstanding === true,
    );
    // These are interactive workflow/input-preparation channels. Fixed Tools
    // live in Cube and are not in this map; releasing their caller never kills them.
    const operations = [...activation.operations.values()];
    for (const operation of operations)
      operation.controller.abort(new Error("Agent binding released"));
    await Promise.allSettled(operations.map((operation) => operation.result));
    await this.#bindings.release(activation.activationId, activation.assignment);
    if (activation.elasticRuntime !== undefined) {
      if (request.disposition === "detach") {
        throw new SandboxControlError(
          "tool_binding_identity_mismatch",
          "Elastic Tool Sandbox bindings cannot detach from their runtime",
          false,
        );
      }
      return this.#releaseElasticBinding(request, activation);
    }
    if (request.disposition !== "detach") {
      throw new SandboxControlError(
        "tool_binding_identity_mismatch",
        "Development environment Tool bindings must detach from their machine",
        false,
      );
    }
    const handle = activation.handle;
    this.#revokeBinding(request.activationId);
    const environmentId = activation.developmentEnvironmentId;
    const environment =
      environmentId === undefined ? undefined : this.#developmentEnvironments.get(environmentId);
    if (environment === undefined || !environment.bindingIds.has(request.activationId)) {
      throw new SandboxControlError(
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
      this.#warm.set(runtime.workspaceKey, runtime);
      return {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.released",
        requestId: request.requestId,
        activationId: request.activationId,
        retained: true,
      };
    }

    await this.#stateRepository.setWorkspaceRuntimeState(
      runtime.physicalActivationId,
      "cleaning",
      runtime.handle ? { handle: runtime.handle } : {},
    );
    await this.#closePhysical(
      runtime.physicalActivationId,
      runtime.spec.assignment,
      "workspace",
      runtime.handle,
    );
    if (runtime.handle !== undefined) {
      await this.#serviceRegistry?.endRuntime(runtime.handle.runtimeId).catch(() => undefined);
    }
    this.#admission.release(runtime.physicalActivationId);
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

  async #releaseDetachedBinding(
    activationId: string,
    assignment: ToolSandboxAssignment,
    cancelOutstanding: boolean,
  ): Promise<void> {
    const identity = parseExecutionReference(assignment.executionReference);
    const route = await this.#bindings.get(
      {
        tenantId: assignment.tenantId,
        runId: identity.runId,
        writerId: identity.leaseId,
      },
      activationId,
    );
    if (route) {
      if (!sameAssignment(route.snapshot.assignment, assignment))
        throw new SandboxControlError(
          "tool_binding_identity_mismatch",
          "Closing binding identity did not match",
          false,
        );
      await this.#bindings.closeBinding(activationId, assignment, cancelOutstanding);
      await this.#bindings.release(activationId, assignment);
    }
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
        throw new SandboxControlError(
          "persistent_machine_recovery_state_unavailable",
          "Development environment recovery state was unavailable after Agent execution",
          true,
        );
      }
      await this.#stateRepository.returnDevelopmentEnvironment(
        environment.reservation.environmentId,
        activation.reservation.activationId,
        {
          handle: environment.handle,
          runtimeCapsule,
        },
      );
    } catch (error: unknown) {
      await this.#stateRepository
        .returnDevelopmentEnvironment(
          environment.reservation.environmentId,
          activation.reservation.activationId,
          { handle: environment.handle },
        )
        .catch(() => undefined);
      throw error;
    }
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
    return (await this.#bindings.inventory(sandboxId)).map((route) => {
      const assignment = route.snapshot.assignment;
      return {
        containerId: route.bindingId,
        containerName: route.descriptor.target.sandboxId,
        supervisorId: assignment.supervisorId,
        bootId: assignment.bootId,
        sandboxId: assignment.sandboxId,
        runId: assignment.runId,
        workspaceId: assignment.workspaceId,
        sessionId: assignment.sessionId,
        turnId: assignment.turnId,
        executionReference: assignment.executionReference,
      };
    });
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const routes = await this.#bindings.inventory(assignment.sandboxId);
    for (const route of routes.filter(
      (row) =>
        row.bindingId === assignment.containerId &&
        sameSupervisorAssignment(row.snapshot.assignment, assignment),
    )) {
      await this.#releaseActivation({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: this.#idGenerator(),
        activationId: route.bindingId,
        assignment: route.snapshot.assignment,
        cancelOutstanding: true,
        disposition: route.snapshot.developmentEnvironmentId ? "detach" : "keep_warm",
      });
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    // This retires Agent routing authority, never proves VM/process absence.
    await this.terminateAndConfirmAbsent(assignment);
  }

  async listWorkspaceDirectory(
    request: SandboxControlListWorkspaceDirectoryRequest,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse> {
    return this.#workspaceFiles.listWorkspaceDirectory(request);
  }

  async prepareWorkspaceUpload(request: WorkspaceUploadRequest): Promise<void> {
    await this.#authorizeUpload(request);
  }

  async #authorizeUpload(request: WorkspaceUploadRequest) {
    this.#stateRepository.assertLocalOwnership();
    if (!this.#stateRepository.authorizeWorkspaceUpload)
      throw new SandboxControlError(
        "workspace_upload_unavailable",
        "Upload authorization is unavailable",
        false,
      );
    await this.#stateRepository.authorizeWorkspaceUpload(request, request.byteLength);
    return request.machine ? this.#machineBrowserHandle(request) : undefined;
  }

  async uploadWorkspaceFile(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    return this.#workspaceFiles.uploadWorkspaceFile(request, chunks, signal);
  }

  async readWorkspaceFile(
    request: SandboxControlReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlReadWorkspaceFileResponse> {
    return this.#workspaceFiles.readWorkspaceFile(request, signal);
  }

  async #machineBrowserHandle(
    request:
      | SandboxControlListWorkspaceDirectoryRequest
      | SandboxControlReadWorkspaceFileRequest
      | WorkspaceUploadRequest,
  ): Promise<SandboxHandle> {
    const target = request.machine!;
    const owner = await this.#stateRepository.developmentEnvironmentOwner(
      request.tenantId,
      target.userId,
      target.environmentId,
    );
    if (owner.status === "redirect") throw new SandboxOwnerRedirectError(owner.ownerBaseUrl);
    if (
      owner.status !== "owned" ||
      owner.state !== "ready" ||
      owner.reservation.desiredState !== "running" ||
      owner.reservation.workspaceId !== request.workspaceId
    ) {
      throw new SandboxControlError(
        "workspace_browser_unavailable",
        "Machine Workspace is not running or owned by this user",
        false,
      );
    }
    const machine = this.#developmentEnvironments.get(target.environmentId);
    if (!machine)
      throw new SandboxControlError(
        "workspace_browser_unavailable",
        "Machine ownership recovery is pending",
        true,
      );
    return machine.handle;
  }

  async authorizeSourceCredential(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    if (this.#credentials.authorizeSourceCredential === undefined) {
      throw new SandboxControlError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot store Workspace Git credentials",
        false,
      );
    }
    return this.#credentials.authorizeSourceCredential(request);
  }

  async preflightSourceCredential(
    request: SourceControlWorkspaceCredentialPreflightRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    if (this.#credentials.preflightSourceCredential === undefined) {
      throw new SandboxControlError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot verify Workspace Git credentials",
        false,
      );
    }
    return this.#credentials.preflightSourceCredential(request);
  }

  async listSourceCredentials(
    request: SourceControlWorkspaceCredentialListRequest,
  ): Promise<SourceControlWorkspaceCredentialListResponse> {
    if (this.#credentials.listSourceCredentials === undefined) {
      throw new SandboxControlError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot list Workspace Git credentials",
        false,
      );
    }
    return this.#credentials.listSourceCredentials(request);
  }

  async disconnectSourceCredential(
    request: SourceControlWorkspaceCredentialDisconnectRequest,
  ): Promise<SourceControlWorkspaceCredentialDisconnectResponse> {
    if (this.#credentials.disconnectSourceCredential === undefined) {
      throw new SandboxControlError(
        "source_control_credential_unavailable",
        "The configured Sandbox Provider cannot disconnect Workspace Git credentials",
        false,
      );
    }
    return this.#credentials.disconnectSourceCredential(request);
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];
    this.#admission.close();
    clearInterval(this.#reaper);
    this.#cleanupController.abort();
    await this.#runtimeHealth.close();
    await this.#cleanupLoop;
    await this.#developmentEnvironmentRecovery?.catch((error) => {
      errors.push(error);
    });
    await Promise.allSettled([...this.#workspaceRuntimeProvisioningTails.values()]);
    const localOperations = [...this.#toolBindings.values()].flatMap((binding) => [
      ...binding.operations.values(),
    ]);
    for (const operation of localOperations) operation.controller.abort();
    await Promise.allSettled(localOperations.map((operation) => operation.result));
    await Promise.all(
      [...this.#terminals.entries()].map(([terminalId, terminal]) =>
        this.#closeTerminal(terminalId, terminal).catch((error) => {
          errors.push(error);
        }),
      ),
    );
    for (const environment of this.#developmentEnvironments.values()) {
      environment.terminal?.disconnect();
      await environment.terminal?.kill().catch((error) => {
        errors.push(error);
      });
      let capsule: string | undefined;
      let detachableHandle = environment.handle;
      try {
        const bindings = [...environment.bindingIds]
          .map((bindingId) => this.#toolBindings.get(bindingId))
          .filter((binding): binding is ManagedToolBinding => binding !== undefined);
        if (bindings.length > 0) {
          for (const binding of bindings) {
            detachableHandle = binding.handle ?? detachableHandle;
            this.#toolBindings.delete(binding.activationId);
          }
          environment.handle = detachableHandle;
          environment.bindingIds.clear();
          capsule = await this.#persistentCapsule(detachableHandle);
          if (capsule === undefined) {
            throw new SandboxControlError(
              "persistent_machine_recovery_state_unavailable",
              "Exclusive machine recovery state was unavailable during Sandbox control shutdown",
              false,
            );
          }
          await this.#stateRepository.setDevelopmentEnvironmentState(
            environment.reservation,
            environment.failure === undefined ? "ready" : "reconciling",
            {
              handle: detachableHandle,
              agentActive: true,
              runtimeCapsule: capsule,
              ...(environment.failure === undefined
                ? {}
                : { failureCode: environment.failure.code }),
            },
          );
        } else {
          const inspection = await this.#provider.inspect(detachableHandle);
          if (inspection.state === "absent") {
            throw new SandboxControlError(
              "persistent_machine_disappeared",
              "Exclusive machine disappeared during Sandbox control shutdown",
              false,
            );
          }
          capsule = await this.#persistentCapsule(detachableHandle);
          if (capsule === undefined) {
            throw new SandboxControlError(
              "persistent_machine_recovery_state_unavailable",
              "Exclusive machine recovery state was unavailable during Sandbox control shutdown",
              false,
            );
          }
          await this.#stateRepository.setDevelopmentEnvironmentState(
            environment.reservation,
            environment.failure === undefined &&
              (inspection.state === "running" || inspection.state === "paused")
              ? "ready"
              : "reconciling",
            {
              handle: detachableHandle,
              runtimeCapsule: capsule,
              ...(environment.failure === undefined
                ? {}
                : { failureCode: environment.failure.code }),
            },
          );
        }
        await this.#provider.detachPersistent?.(detachableHandle);
      } catch (error: unknown) {
        errors.push(error);
        await this.#stateRepository
          .setDevelopmentEnvironmentState(environment.reservation, "reconciling", {
            handle: detachableHandle,
            failureCode: operationFailureCode(error),
            ...(capsule === undefined ? {} : { runtimeCapsule: capsule }),
          })
          .catch((failure) => {
            errors.push(failure);
          });
        await this.#provider.detachPersistent?.(detachableHandle).catch((failure) => {
          errors.push(failure);
        });
      }
      this.#admission.release(environment.reservation.allocationId);
    }
    this.#developmentEnvironments.clear();
    const runtimes = new Set([
      ...this.#warm.values(),
      ...[...this.#toolBindings.values()].flatMap((binding) =>
        binding.elasticRuntime ? [binding.elasticRuntime] : [],
      ),
    ]);
    for (const runtime of runtimes) {
      if (!runtime.handle) continue;
      try {
        const capsule = await this.#persistentCapsule(runtime.handle);
        if (!capsule) throw new Error("Runtime recovery capsule unavailable during shutdown");
        await this.#stateRepository.setWorkspaceRuntimeState(
          runtime.physicalActivationId,
          runtime.failure ? "unknown" : "allocated",
          {
            handle: runtime.handle,
            runtimeCapsule: capsule,
            ...(runtime.failure ? { failureCode: runtime.failure.code } : {}),
          },
        );
      } catch (error) {
        errors.push(error);
      }
      await this.#provider.detachPersistent?.(runtime.handle).catch((error) => errors.push(error));
    }
    this.#toolBindings.clear();
    this.#warm.clear();
    try {
      await this.#provider.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#stateRepository.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Sandbox control shutdown failed", { cause: errors[0] });
  }

  async #persistentCapsule(handle: SandboxHandle): Promise<string | undefined> {
    if (this.#provider.persistentCapsule === undefined) {
      return undefined;
    }
    try {
      return (await this.#provider.persistentCapsule(handle)).capsule;
    } catch (error: unknown) {
      if (error instanceof SandboxControlError && error.code === "persistent_capsule_key_missing") {
        return undefined;
      }
      throw error;
    }
  }

  reapWorkspaceRuntimes(): Promise<void> {
    return (this.#workspaceCleanup ??= (async () => {
      const runtimes = new Set([
        ...this.#warm.values(),
        ...[...this.#toolBindings.values()].flatMap((b) =>
          b.elasticRuntime ? [b.elasticRuntime] : [],
        ),
      ]);
      for (const runtime of runtimes)
        if (runtime.failure && !runtime.failureRecorded)
          await this.#markElasticRuntimeLost(runtime, runtime.failure);
      await this.reapRetiredWarm();
      await this.#reapOrphanedWorkspaceRuntimes();
      await this.#reapUnboundWorkspaceRuntimes();
    })().finally(() => {
      this.#workspaceCleanup = undefined;
    }));
  }

  async observeRuntimeHealth(): Promise<void> {
    this.#runtimeHealth.refresh();
    await this.#runtimeHealth.settle();
  }

  recordRuntimeEvidence(tenantId: string, targetId: string, observedAt: number): boolean {
    if (this.#closing) return false;
    if (!this.#runtimeHealthTargets().some((t) => t.id === targetId && t.tenantId === tenantId))
      return false;
    this.#runtimeHealth.refresh();
    return this.#runtimeHealth.evidence(targetId, observedAt);
  }

  #runtimeHealthTargets(): Array<RuntimeHealthTarget & { tenantId: string }> {
    const runtimes = new Set([
      ...this.#warm.values(),
      ...[...this.#toolBindings.values()].flatMap((binding) =>
        binding.elasticRuntime ? [binding.elasticRuntime] : [],
      ),
    ]);
    const candidates = [...runtimes]
      .filter((runtime) => runtime.handle && !runtime.failure)
      .map((runtime) => ({
        handle: runtime.handle!,
        fail: (error: Error) => this.#markElasticRuntimeLost(runtime, error),
      }))
      .concat(
        [...this.#developmentEnvironments.values()]
          .filter((environment) => !environment.failure)
          .map((environment) => ({
            handle: environment.handle,
            fail: (error: Error) => this.#quarantineDevelopmentEnvironment(environment, error),
          })),
      );
    return candidates.flatMap((candidate) => {
      let id: string;
      try {
        id = this.#execution.executionIdentity(candidate.handle);
      } catch (error) {
        // A missing local handle is not physical VM-loss evidence. Keep other
        // targets observable and report the affected resource for recovery.
        this.#onMaintenanceError?.(error);
        return [];
      }
      return [
        {
          tenantId: candidate.handle.assignment.tenantId,
          id,
          observe: () => this.#provider.observeRuntime(candidate.handle),
          probe: () => this.#execution.probeExecution(candidate.handle),
          fail: () =>
            candidate.fail(
              new SandboxControlError(
                "execution_stop_unconfirmed",
                "Runtime execution is unavailable; control-plane recovery is required",
                false,
              ),
            ),
        },
      ];
    });
  }

  async reapRetiredWarm(): Promise<void> {
    const retired = new Set(await this.#stateRepository.listRetiredWarmWorkspaceRuntimeIds());
    if (retired.size === 0) return;
    for (const [key, warm] of this.#warm) {
      if (!retired.has(warm.physicalActivationId) || this.#warm.get(key) !== warm) continue;
      await this.#discardWarm(key, warm);
    }
  }

  #authorizedBinding(activationId: string, executionReference: string): ManagedToolBinding {
    const activation = this.#toolBindings.get(activationId);
    if (
      activation === undefined ||
      activation.assignment.executionReference !== executionReference
    ) {
      throw new SandboxControlError(
        "stale_session_lease",
        "Tool binding operation used a stale Session lease",
        false,
      );
    }
    return activation;
  }

  #ownedBinding(activationId: string, assignment: ToolSandboxAssignment): ManagedToolBinding {
    this.#stateRepository.assertLocalOwnership();
    const activation = this.#toolBindings.get(activationId);
    if (activation === undefined || !sameAssignment(activation.assignment, assignment)) {
      throw new SandboxControlError(
        "tool_binding_identity_mismatch",
        "Tool binding assignment identity did not match",
        false,
      );
    }
    return activation;
  }

  #revokeBinding(activationId: string): void {
    this.#toolBindings.delete(activationId);
    this.#admission.cancel(activationId);
  }

  async #materialize(activation: ManagedToolBinding, signal?: AbortSignal): Promise<SandboxHandle> {
    if (activation.developmentEnvironmentId !== undefined) {
      const failure = this.#developmentEnvironments.get(
        activation.developmentEnvironmentId,
      )?.failure;
      if (failure !== undefined) throw failure;
    }
    if (activation.elasticRuntime !== undefined) {
      const handle = await this.#materializeElasticRuntime(activation.elasticRuntime, signal);
      activation.usedPhysicalRuntime = true;
      return handle;
    }
    const handle = activation.handle;
    if (activation.developmentEnvironmentId === undefined || handle === undefined) {
      throw new SandboxControlError(
        "development_environment_unavailable",
        "Development environment runtime is unavailable",
        true,
      );
    }
    if (signal?.aborted) {
      throw new SandboxControlError(
        "tool_operation_cancelled",
        "Tool operation was cancelled",
        false,
      );
    }
    if (
      handle.activationId !== activation.spec.activationId ||
      handle.assignment.tenantId !== activation.assignment.tenantId ||
      handle.assignment.projectId !== activation.assignment.projectId ||
      handle.assignment.workspaceId !== activation.assignment.workspaceId ||
      !sameEnvironment(handle.environment, activation.spec.environment)
    ) {
      throw new SandboxControlError(
        "sandbox_provider_protocol_error",
        "Development environment returned a mismatched handle",
        false,
      );
    }
    activation.usedPhysicalRuntime = true;
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
      let allocationStarted = false;
      try {
        await this.#admission.acquire(
          runtime.physicalActivationId,
          runtime.spec.assignment,
          signal,
        );
        allocationStarted = true;
        const handle = await this.#createPhysical(runtime.spec);
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
          let absent = false;
          try {
            await this.#closePhysical(
              runtime.physicalActivationId,
              runtime.spec.assignment,
              "workspace",
            );
            absent = true;
          } catch {}
          throw new SandboxCreationError(
            new SandboxControlError(
              "sandbox_provider_protocol_error",
              "Sandbox Provider returned a mismatched Workspace runtime handle",
              false,
            ),
            absent,
          );
        }
        runtime.handle = handle;
        const runtimeCapsule = await this.#persistentCapsule(handle);
        if (!runtimeCapsule) throw new Error("Runtime recovery capsule is unavailable");
        await this.#stateRepository.setWorkspaceRuntimeState(
          runtime.physicalActivationId,
          "allocated",
          {
            handle,
            runtimeCapsule,
          },
        );
        runtime.capsuleStored = true;
        return handle;
      } catch (error: unknown) {
        const absent =
          !allocationStarted || (error instanceof SandboxCreationError && error.absenceConfirmed);
        if (absent) this.#admission.release(runtime.physicalActivationId);
        await this.#stateRepository
          .setWorkspaceRuntimeState(runtime.physicalActivationId, absent ? "released" : "unknown", {
            failureCode: operationFailureCode(error),
            ...(runtime.handle ? { handle: runtime.handle } : {}),
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
      error instanceof SandboxControlError
        ? error
        : new SandboxControlError(
            "workspace_runtime_lost",
            "Workspace runtime was lost during Tool execution",
            true,
            error,
          );
    runtime.failure ??= failure;
    if (!runtime.failureRecorded) {
      await this.#stateRepository.setWorkspaceRuntimeState(
        runtime.physicalActivationId,
        "unknown",
        {
          failureCode: runtime.failure.code,
          ...(runtime.handle ? { handle: runtime.handle } : {}),
        },
      );
      runtime.failureRecorded = true;
    }
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
    await this.#bindings.confirmPhysicalClosure(runtime.physicalActivationId);
  }

  async #reapOrphanedWorkspaceRuntimes(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedWorkspaceRuntimes(16);
    for (const orphan of orphaned) await this.#retireWorkspaceRuntime(orphan);
  }

  async #reapUnboundWorkspaceRuntimes(minimumUnboundAgeMs?: number): Promise<void> {
    const orphaned = await this.#stateRepository.claimUnboundWorkspaceRuntimes(
      16,
      minimumUnboundAgeMs,
    );
    for (const orphan of orphaned) await this.#retireWorkspaceRuntime(orphan);
  }

  async #retireWorkspaceRuntime(orphan: OrphanedWorkspaceRuntime): Promise<void> {
    // A physical Cube can have many task bindings, none named after the original
    // activation after warm reuse. Retire the physical identity in every local
    // index before a successor is allowed to reserve the same Workspace.
    await this.#serializeWorkspaceRuntimeProvisioning(orphan.assignment, async () => {
      let handle: SandboxHandle | undefined;
      for (const [id, binding] of this.#toolBindings) {
        const runtime = binding.elasticRuntime;
        if (runtime?.physicalActivationId !== orphan.activationId) continue;
        for (const operation of binding.operations.values()) operation.controller.abort();
        handle ??= runtime.handle;
        runtime.bindingIds.delete(id);
        this.#revokeBinding(id);
      }
      for (const [key, warm] of this.#warm) {
        if (warm.physicalActivationId !== orphan.activationId) continue;
        handle ??= warm.handle;
        this.#warm.delete(key);
      }
      try {
        await this.#closePhysical(
          orphan.activationId,
          orphan.assignment,
          "workspace",
          handle,
          orphan.runtimeCapsule,
        );
        await this.#bindings.releaseAfterPhysicalAbsence(orphan.activationId);
        if (handle) await this.#serviceRegistry?.endRuntime(handle.runtimeId);
        await this.#stateRepository.setWorkspaceRuntimeState(orphan.activationId, "released");
        this.#admission.release(orphan.activationId);
      } catch (error: unknown) {
        await this.#stateRepository
          .setWorkspaceRuntimeState(orphan.activationId, "unknown", {
            failureCode: operationFailureCode(error),
          })
          .catch(() => undefined);
      }
    });
  }

  async #reapOrphanedTerminals(): Promise<void> {
    const orphaned = await this.#stateRepository.claimOrphanedTerminals(16);
    for (const terminal of orphaned) {
      if (terminal.sharedRuntime) {
        await this.#stateRepository.setTerminalState(terminal.terminalId, "released");
        continue;
      }
      const assignment = terminalAssignment(
        terminal.terminalId,
        terminal,
        createExecutionReference(terminal.terminalId, terminal.terminalId, terminal.fencingToken),
      );
      try {
        await this.#closePhysical(terminal.terminalId, assignment, "terminal");
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

  async #verifyDevelopmentEnvironment(
    environment: ManagedDevelopmentEnvironment,
  ): Promise<{ continuityId: string }> {
    const observation = await this.#execution.probeExecution(environment.handle);
    const runtimeCapsule = await this.#persistentCapsule(environment.handle);
    if (runtimeCapsule === undefined) {
      throw new SandboxControlError(
        "persistent_machine_recovery_state_unavailable",
        "Development machine recovery state is unavailable",
        false,
      );
    }
    await this.#stateRepository.setDevelopmentEnvironmentState(environment.reservation, "ready", {
      handle: environment.handle,
      runtimeCapsule,
    });
    delete environment.failure;
    delete environment.failureRecorded;
    delete environment.closureConfirmed;
    return observation;
  }

  async #quarantineDevelopmentEnvironment(
    environment: ManagedDevelopmentEnvironment,
    error: unknown,
  ): Promise<void> {
    environment.failure ??=
      error instanceof SandboxControlError
        ? error
        : new SandboxControlError(
            "cubesandbox_tool_unavailable",
            "Development machine execution is unavailable",
            false,
            error,
          );
    if (!environment.failureRecorded) {
      await this.#stateRepository.setDevelopmentEnvironmentState(
        environment.reservation,
        "reconciling",
        {
          handle: environment.handle,
          failureCode: environment.failure.code,
        },
      );
      environment.failureRecorded = true;
    }
    await this.#bindings.confirmPhysicalClosure(environment.reservation.allocationId);
    environment.closureConfirmed = true;
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
          this.#warm.set(workspaceRuntime.workspaceKey, workspaceRuntime);
        }
        await this.#stateRepository.setTerminalState(terminalId, "released");
        return;
      }
      try {
        await this.#closePhysical(terminalId, terminal.assignment, "terminal", terminal.handle);
        this.#admission.release(terminalId);
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

  async #discardWarm(key: string, warm: ManagedElasticRuntime): Promise<boolean> {
    this.#stateRepository.assertLocalOwnership();
    if (warm.bindingIds.size > 0 || warm.workspaceTerminalId !== undefined) {
      if (this.#warm.get(key) === warm) this.#warm.delete(key);
      return false;
    }
    if (!(await this.#stateRepository.claimWarmRuntimeRetirement(warm.physicalActivationId))) {
      return false;
    }
    this.#warm.delete(key);
    await this.#closePhysical(
      warm.physicalActivationId,
      warm.spec.assignment,
      "workspace",
      warm.handle,
    );
    if (warm.handle) {
      await this.#serviceRegistry?.endRuntime(warm.handle.runtimeId);
    }
    this.#admission.release(warm.physicalActivationId);
    await this.#stateRepository.setWorkspaceRuntimeState(warm.physicalActivationId, "released");
    return true;
  }

  async #serializeWorkspaceRuntimeProvisioning<T>(
    assignment: Pick<ToolSandboxAssignment, "tenantId" | "projectId" | "workspaceId">,
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
}
import { RuntimeHealthMonitor, type RuntimeHealthTarget } from "./runtime-health-monitor.ts";
