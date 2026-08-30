import type {
  AgentWorkspaceSeed,
  EnvironmentRuntimeSnapshot,
  EnvironmentValidationReport,
  WorkspaceBlob,
  ToolBrokerListWorkspaceDirectoryRequest,
  ToolBrokerListWorkspaceDirectoryResponse,
  ToolBrokerReadWorkspaceFileRequest,
  ToolBrokerReadWorkspaceFileResponse,
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCaptureResponse,
  ToolSandboxOperationRequest,
  ToolSandboxOperationResponse,
  ToolBrokerWorkspaceForkRequest,
  SourceControlWorkspaceCredentialAuthorizeRequest,
  SourceControlWorkspaceCredentialPreflightRequest,
  SourceControlWorkspaceCredentialResponse,
} from "@pi-cloud/protocol";

export const SANDBOX_PROVIDER_API_VERSION = 1 as const;

export class ToolBrokerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean, cause?: unknown) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ToolBrokerError";
    this.code = code;
    this.retryable = retryable;
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
  turnWallClockTimeoutMs: number;
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
  workspaceSettlement?: WorkspaceBlob;
  policy: SandboxPolicy;
  toolRoot?: string;
  lifetime?: "development_environment";
  sandboxProfileKey?: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
}>;

export type SandboxHandle = Readonly<{
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

export type SandboxWorkspaceForkResult = Readonly<{
  sourceHandle: SandboxHandle;
  sourceSettlementRevision: string;
  targetSettlementRevision: string;
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
      state: "running" | "stopped";
      handle: SandboxHandle;
      effectiveIsolation: SandboxEffectiveIsolation;
    }>;

export type SandboxReadFileInput = Readonly<{
  operationId: string;
  path: string;
}>;

export type SandboxWriteFileInput = Readonly<{
  operationId: string;
  path: string;
  content: string;
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

export type SandboxPreviewHttpRequest = Readonly<{
  port: number;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
}>;

export type SandboxPreviewHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

/**
 * Provider-neutral execution contract owned by the trusted Tool Broker.
 * Implementations must not expose their native SDK/client objects through a
 * handle or require the Agent Runner to know provider-specific arguments.
 */
export interface SandboxProvider {
  readonly providerId: string;
  readonly cleanPrewarmCount?: number;
  /** Provider-specific policy selected only by trusted deployment config. */
  readonly defaultPolicy: SandboxPolicy;
  checkHealth(): Promise<void>;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
    toolRoot?: string,
  ): Promise<ToolSandboxOperationResponse>;
  discoverHttpServices?(
    handle: SandboxHandle,
    signal?: AbortSignal,
  ): Promise<SandboxHttpServiceDiscovery>;
  readFile(
    handle: SandboxHandle,
    input: SandboxReadFileInput,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  writeFile(
    handle: SandboxHandle,
    input: SandboxWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Open a human-operated PTY without granting Agent Tool authority. */
  openTerminal?(handle: SandboxHandle, size: SandboxTerminalSize): Promise<SandboxTerminalSession>;
  /** Proxy one tenant-authorized HTTP request through the runtime's private ingress token. */
  previewHttp?(
    handle: SandboxHandle,
    request: SandboxPreviewHttpRequest,
  ): Promise<SandboxPreviewHttpResponse>;
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
  /** Create one user-owned directory and return its parent listing. */
  createDirectory?(
    handle: SandboxHandle,
    path: string,
    name: string,
  ): Promise<SandboxDirectoryListing>;
  settle(
    handle: SandboxHandle,
    requestId: string,
    binding?: Readonly<{ activationId: string; assignment: ToolSandboxAssignment }>,
  ): Promise<ToolSandboxCaptureResponse>;
  forkWorkspace?(
    handle: SandboxHandle,
    request: ToolBrokerWorkspaceForkRequest,
  ): Promise<SandboxWorkspaceForkResult>;
  stop(handle: SandboxHandle): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxInspection>;
  /** List only one current directory from the persistent Workspace Volume. */
  listWorkspaceDirectory?(
    request: ToolBrokerListWorkspaceDirectoryRequest,
  ): Promise<ToolBrokerListWorkspaceDirectoryResponse>;
  /** Read one current bounded file without creating a Cube. */
  readWorkspaceFile?(
    request: ToolBrokerReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerReadWorkspaceFileResponse>;
  authorizeSourceCredential?(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse>;
  preflightSourceCredential?(
    request: SourceControlWorkspaceCredentialPreflightRequest,
  ): Promise<SourceControlWorkspaceCredentialResponse>;
  /** Used only when the Tool Broker restarted before it could reconstruct a handle. */
  destroyRuntime(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;

  listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]>;
  terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
  confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void>;
  close(): Promise<void>;
}
