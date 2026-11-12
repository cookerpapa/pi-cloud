import type { Duplex } from "node:stream";
import type { ExecutionLogPosition, GuestProbeReply } from "@pi-cloud/protocol";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";

/** The Guest ran successfully, but the requested application port refused TCP. */
export class GuestApplicationPortError extends Error {
  constructor() {
    super("Application port is not accepting connections");
  }
}

/** Provider-independent mechanics used by the fixed Linux Guest adapter.
 * Native connection fields are private to each driver's instance subtype. */
export type GuestRuntimeInstance = Readonly<{
  sandboxId: string;
  templateId: string;
  state: import("./sandbox-provider.ts").SandboxObservedState;
  nodeId?: string;
  metadata: Readonly<Record<string, string>>;
  cpuCount?: number;
  memoryMB?: number;
}>;
export type GuestRuntimeCreateInput = Readonly<{
  templateId: string;
  metadata: Readonly<Record<string, string>>;
  volumeMounts?: readonly Readonly<{
    name: string;
    path: "/workspace" | "/home/user";
    storage: import("./workspace-persistence.ts").WorkspaceVolumeReference;
  }>[];
}>;
export type GuestToolHandoff = Readonly<{
  source: ExecutionLogPosition;
  operationId: string;
  executionScopeId: string;
  writerId: string;
  payload: unknown;
  timeoutMs: number;
}>;
export type GuestCommandRequest = Readonly<{
  command: string;
  cwd: string;
  user: string;
  timeoutMs: number;
  maximumOutputBytes: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => Promise<void>;
}>;

export type GuestCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface GuestRuntimeClient<I extends GuestRuntimeInstance = GuestRuntimeInstance> {
  openProgram?(instance: I, input: { script: string; cwd: string }): Promise<Duplex>;
  openTcp?(instance: I, port: number, signal?: AbortSignal): Promise<Duplex>;
  checkHealth(): Promise<void>;
  create(input: GuestRuntimeCreateInput): Promise<I>;
  read(sandboxId: string): Promise<I | undefined>;
  observe(
    sandboxId: string,
    nodeId?: string,
    expected?: I,
  ): Promise<import("./sandbox-provider.ts").SandboxRuntimeObservation>;
  executionTarget(
    sandboxId: string,
    nodeId: string,
    connection?: I,
  ): Promise<SandboxExecutionTarget>;
  probeExecution(target: SandboxExecutionTarget, probeId: string): Promise<GuestProbeReply>;
  submitProbe(
    target: SandboxExecutionTarget,
    request: {
      probeId: string;
      delivery: unknown;
    },
  ): Promise<void>;
  submitTool(target: SandboxExecutionTarget, request: GuestToolHandoff): Promise<void>;
  cancelTool(
    target: SandboxExecutionTarget,
    request: {
      source: ExecutionLogPosition;
      executionScopeId: string;
      writerId: string;
      operationId?: string;
    },
  ): Promise<void>;

  pause(sandboxId: string): Promise<void>;
  connect(sandboxId: string): Promise<I>;
  list(): Promise<readonly I[]>;
  destroy(sandboxId: string, expected?: I): Promise<void>;
  runCommand(instance: I, input: GuestCommandRequest): Promise<GuestCommandResult>;
  writeGuestFileStream(
    instance: I,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<void>;
  writeGuestFile(instance: I, path: string, data: Uint8Array): Promise<void>;
  openTerminal(
    instance: I,
    input: Readonly<{
      rows: number;
      cols: number;
      admin: boolean;
    }>,
  ): Promise<GuestTerminal>;
  close(): Promise<void>;
}

export interface GuestTerminal {
  readonly output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: Readonly<{ rows: number; cols: number }>): Promise<void>;
  kill(): Promise<void>;
  disconnect(): void;
}

/** Endpoint refusal, distinct from a lost transport ACK. A stale position or
 * changed operation can refer to earlier effects and must remain UNKNOWN. */
export class GuestExecutionRejected extends Error {
  constructor(readonly code: string) {
    super(`Guest execution refused: ${code}`);
  }
}

export class SandboxRuntimeClientError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "SandboxRuntimeClientError";
    this.statusCode = statusCode;
  }
}

/** No trustworthy HTTP response; effects may already have been admitted. */
export class SandboxRuntimeTransportError extends SandboxRuntimeClientError {
  constructor(cause: unknown) {
    super("Provider API transport did not return a response");
    this.name = "SandboxRuntimeTransportError";
    this.cause = cause;
  }
}
