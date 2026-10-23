import type {
  AgentWorkspaceSeed,
  EnvironmentRuntimeSnapshot,
  EnvironmentValidationReport,
  SandboxControlListWorkspaceDirectoryRequest,
  SandboxControlListWorkspaceDirectoryResponse,
  SandboxControlReadWorkspaceFileRequest,
  SandboxControlReadWorkspaceFileResponse,
  ToolSandboxAssignment,
  SourceControlWorkspaceCredentialAuthorizeRequest,
  SourceControlWorkspaceCredentialDisconnectRequest,
  SourceControlWorkspaceCredentialDisconnectResponse,
  SourceControlWorkspaceCredentialListRequest,
  SourceControlWorkspaceCredentialListResponse,
  SourceControlWorkspaceCredentialPreflightRequest,
  SourceControlWorkspaceCredentialResponse,
} from "@pi-cloud/protocol";
import type { Duplex } from "node:stream";
import type { WorkspaceUploadRequest } from "@pi-cloud/protocol";
import type { WorkspaceUploadReceipt } from "./workspace-volume-gateway-contract.ts";

export class SandboxControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, cause?: unknown) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "SandboxControlError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Allocation failures distinguish confirmed absence from an uncertain VM. */
export class SandboxCreationError extends SandboxControlError {
  constructor(
    error: unknown,
    readonly absenceConfirmed: boolean,
  ) {
    super(
      error instanceof SandboxControlError ? error.code : "cubesandbox_creation_unconfirmed",
      error instanceof SandboxControlError ? error.message : "Sandbox creation did not complete",
      error instanceof SandboxControlError ? error.retryable : false,
      error,
    );
  }
}

export type SandboxNetworkPolicy = Readonly<{ mode: "public_web_proxy_private_denied" }>;

export type SandboxResourceLimits = Readonly<{
  cpuNano: number;
  memoryBytes: number;
  pids: number;
  openFiles: number;
  temporaryBytes: number;
  workspaceBytes: number;
  maximumOutputBytes: number;
  maximumCommandTimeoutMs: number;
}>;

export type SandboxPolicy = Readonly<{
  policyVersion: 1;
  network: SandboxNetworkPolicy;
  resources: SandboxResourceLimits;
  user: "1000:1000";
  readOnlyRootFilesystem: boolean;
  privileged: boolean;
  dropAllCapabilities: boolean;
  noNewPrivileges: boolean;
  allowHostMounts: boolean;
  allowDockerSocket: boolean;
}>;

export type SandboxCreateSpec = Readonly<{
  activationId: string;
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  workspaceSeed: AgentWorkspaceSeed;
  policy: SandboxPolicy;
  toolRoot?: string;
  lifetime?: "development_environment";
  /** Immutable allocation policy, persisted before the first Cube Create. */
  retentionWindowMs?: number;
  volumeMountPath?: "/workspace" | "/home/user";
  sandboxProfileKey?: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
}>;

/** Issued once by the resource owner before Cube receives any creation RPC. */
export type SandboxAllocationAuthorization = Readonly<{ createBefore: number }>;
export const SANDBOX_CREATION_WINDOW_MS = 5 * 60_000;

export type SandboxHandle = Readonly<{
  allocation: SandboxAllocationAuthorization;
  runtimeNodeId: string;
  providerApiVersion: 1;
  providerId: string;
  activationId: string;
  runtimeId: string;
  runtimeName: string;
  ipAddress?: string;
  workspaceRoot: string;
  assignment: ToolSandboxAssignment;
  environment: EnvironmentRuntimeSnapshot;
  environmentValidation: EnvironmentValidationReport;
}>;

export type PreparedInputImage = Readonly<{
  data: string;
  mimeType: "image/png";
  hints: readonly string[];
}>;

export type SandboxHttpServiceDiscovery = Readonly<{
  listeningPorts: readonly number[];
  httpServices: readonly Readonly<{ port: number; protocol: "http" }>[];
}>;

export type PersistentSandboxCapsule = Readonly<{
  handle: SandboxHandle;
  capsule: string;
}>;

export type SandboxDirectoryEntry = Readonly<{
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  sizeBytes?: number;
}>;

export type SandboxDirectoryListing = Readonly<{
  path: string;
  entries: readonly SandboxDirectoryEntry[];
}>;

type SandboxRuntimeIsolation = Readonly<{
  isolationBoundary: "microvm";
  runtime: "cubesandbox-kvm";
}>;

export type SandboxEffectiveIsolation = SandboxRuntimeIsolation &
  Readonly<{
    user: string;
    privileged: boolean;
    readOnlyRootFilesystem: boolean;
    networkMode: string;
    mountCount: number;
    hasDockerSocket: boolean;
    pidLimit: number | null;
    processLimit: number | null;
    memoryBytes: number | null;
    cpuNano: number | null;
    droppedCapabilities: readonly string[];
    securityOptions: readonly string[];
    sandboxKernelRelease?: string;
  }>;

export type SandboxObservedState =
  "running" | "paused" | "pausing" | "stopped" | "error" | "unknown";

/** One recorded runtime on its recorded node; availability is not disappearance. */
export type SandboxRuntimeObservation = Readonly<{
  runtimeName: string;
  nodeId: string;
  presence: "present" | "absent" | "unavailable";
  state: SandboxObservedState;
  execution?: "ready" | "unavailable" | "unsafe";
}>;

export type SandboxInspection =
  | Readonly<{
      providerApiVersion: 1;
      providerId: string;
      state: "absent";
      handle: SandboxHandle;
    }>
  | Readonly<{
      providerApiVersion: 1;
      providerId: string;
      state: SandboxObservedState;
      handle: SandboxHandle;
      effectiveIsolation: SandboxEffectiveIsolation;
    }>;

export type SandboxTerminalSize = Readonly<{
  rows: number;
  cols: number;
}>;

export type SandboxTerminalSession = Readonly<{
  pid: number;
  output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: SandboxTerminalSize): Promise<void>;
  kill(): Promise<void>;
  disconnect(): void;
}>;

/**
 * Provider-neutral execution contract owned by the trusted Sandbox control.
 * Implementations must not expose their native SDK/client objects through a
 * handle or require the Agent Runner to know provider-specific arguments.
 */
export interface SandboxProvider {
  openWorkflow?(
    handle: SandboxHandle,
    input: { script: string; operationId: string; cwd: string },
  ): Promise<Duplex>;
  openPreviewConnection?(
    handle: SandboxHandle,
    port: number,
    signal?: AbortSignal,
  ): Promise<Duplex>;
  readonly providerId: string;
  readonly cleanPrewarmCount?: number;
  /** Provider-specific policy selected only by trusted deployment config. */
  readonly defaultPolicy: SandboxPolicy;
  checkHealth(): Promise<void>;
  /** Attest Guest execution, not merely the provider's control-plane record. */
  probeExecution(handle: SandboxHandle): Promise<{ continuityId: string }>;
  executionIdentity(handle: SandboxHandle): string;
  observeRuntimeInventory(): Promise<ReadonlyMap<string, SandboxRuntimeObservation>>;
  create(
    spec: SandboxCreateSpec,
    authorization: SandboxAllocationAuthorization,
  ): Promise<SandboxHandle>;
  destroyPersistentCapsule(
    capsule: string,
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<void>;
  describeExecution(
    handle: SandboxHandle,
    bindingId: string,
    toolRoot: string,
  ): Promise<import("./sandbox-execution.ts").SandboxExecutionDescriptor>;
  observeRuntime(handle: SandboxHandle): Promise<SandboxRuntimeObservation>;
  /** Observe an existing creation on its recorded node without adopting or starting it. */
  observeAllocation?(
    id: string,
    authorization: SandboxAllocationAuthorization,
    capsule?: string,
  ): Promise<SandboxRuntimeObservation | undefined>;
  discoverHttpServices?(
    handle: SandboxHandle,
    signal?: AbortSignal,
  ): Promise<SandboxHttpServiceDiscovery>;
  /** Open a human-operated PTY without granting Agent Tool authority. */
  openTerminal?(handle: SandboxHandle, size: SandboxTerminalSize): Promise<SandboxTerminalSession>;
  /** Pause a long-lived user environment while preserving Cube VM state. */
  pause?(handle: SandboxHandle): Promise<void>;
  /** Resume the same paused Cube identity and return its refreshed handle. */
  resume?(handle: SandboxHandle): Promise<SandboxHandle>;
  /** Encrypt enough Provider-local state to adopt one exclusive machine after restart. */
  persistentCapsule?(handle: SandboxHandle): Promise<PersistentSandboxCapsule>;
  /** Restore a previously validated exclusive machine into this Provider process. */
  adoptPersistentCapsule?(capsule: string): Promise<SandboxHandle>;
  /** Forget a preserved machine without destroying its physical Cube. */
  detachPersistent?(handle: SandboxHandle): Promise<void>;
  /** Browse the tenant-owned guest filesystem without restoring a Session settlement. */
  listDirectory?(handle: SandboxHandle, path: string): Promise<SandboxDirectoryListing>;
  listMachineWorkspaceDirectory?(
    handle: SandboxHandle,
    request: SandboxControlListWorkspaceDirectoryRequest,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse>;
  readMachineWorkspaceFile?(
    handle: SandboxHandle,
    request: SandboxControlReadWorkspaceFileRequest,
  ): Promise<SandboxControlReadWorkspaceFileResponse>;
  /** Create one user-owned directory and return its parent listing. */
  createDirectory?(
    handle: SandboxHandle,
    path: string,
    name: string,
  ): Promise<SandboxDirectoryListing>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxInspection>;
  /** List only one current directory from the persistent Workspace Volume. */
  listWorkspaceDirectory?(
    request: SandboxControlListWorkspaceDirectoryRequest,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse>;
  /** Read one current bounded file without creating a Cube. */
  uploadWorkspaceFile?(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceUploadReceipt>;
  prepareInputImage?(
    handle: SandboxHandle,
    source: { chunks: AsyncIterable<Uint8Array>; byteLength: number; mimeType: string },
    signal?: AbortSignal,
  ): Promise<PreparedInputImage>;
  uploadMachineWorkspaceFile?(
    handle: SandboxHandle,
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceUploadReceipt>;
  readWorkspaceFile?(
    request: SandboxControlReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlReadWorkspaceFileResponse>;
  authorizeSourceCredential?(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse>;
  preflightSourceCredential?(
    request: SourceControlWorkspaceCredentialPreflightRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse>;
  listSourceCredentials?(
    request: SourceControlWorkspaceCredentialListRequest,
  ): Promise<SourceControlWorkspaceCredentialListResponse>;
  disconnectSourceCredential?(
    request: SourceControlWorkspaceCredentialDisconnectRequest,
  ): Promise<SourceControlWorkspaceCredentialDisconnectResponse>;
  /** Used only when the Sandbox control restarted before it could reconstruct a handle. */
  destroyRuntime(
    activationId: string,
    assignment: ToolSandboxAssignment,
    authorization: SandboxAllocationAuthorization | undefined,
  ): Promise<void>;

  close(): Promise<void>;
}
