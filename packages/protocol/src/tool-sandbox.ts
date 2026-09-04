import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AgentWorkspaceSeedSchema, WorkspaceBlobSchema } from "./agent-runtime.ts";
import {
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  ExecutionModeSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import {
  EnvironmentRuntimeSnapshotSchema,
  EnvironmentRecipeCommandResultSchema,
  EnvironmentToolchainReportSchema,
  EnvironmentValidationReportSchema,
} from "./environment.ts";
import { CloudToolCapabilitySnapshotSchema, CloudToolNameSchema } from "./tool-capabilities.ts";
import { DevelopmentEnvironmentProfileKeySchema } from "./development-environment-profile.ts";
import { ExecutionLeaseSchema } from "./execution-lease.ts";

export const MAX_TOOL_COMMAND_BYTES = 64 * 1_024;
export const MAX_TOOL_FILE_BYTES = 512 * 1_024;
export const MAX_TOOL_MUTATION_FILE_BYTES = 2 * 1_024 * 1_024;
export const MAX_TOOL_RANGE_FILE_BYTES = 64 * 1_024 * 1_024;
export const MAX_TOOL_READ_RANGE_BYTES = 50 * 1_024;
export const MAX_TOOL_READ_RANGE_LINES = 2_000;
export const MAX_TOOL_OUTPUT_BYTES = 1 * 1_024 * 1_024;

const ToolSandboxEnvelope = {
  toolBrokerProtocolVersion: Type.Literal(1),
};

const WorkerEnvelope = {
  toolWorkerProtocolVersion: Type.Literal(1),
};

const SafeCodeSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

const Base64Schema = Type.String({
  maxLength: Math.ceil(MAX_TOOL_OUTPUT_BYTES / 3) * 4 + 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const MutationFileBase64Schema = Type.String({
  maxLength: Math.ceil(MAX_TOOL_MUTATION_FILE_BYTES / 3) * 4 + 4,
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const ToolOutputChunkSchema = Type.Object(
  {
    seq: PositiveSafeIntegerSchema,
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
    data: Base64Schema,
  },
  { additionalProperties: false },
);

export const ToolWebProxyBootstrapSchema = Type.Object(
  {
    host: Type.String({ minLength: 7, maxLength: 15, pattern: "^[0-9.]+$" }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    directPrivateCidrs: Type.Optional(
      Type.Array(Type.String({ pattern: "^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/(?:2[4-9]|3[0-2])$" }), {
        maxItems: 8,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

const ToolWorkerWorkspaceAttachSchema = Type.Object(
  {
    recipeCommands: Type.Array(EnvironmentRecipeCommandResultSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

export const ToolSandboxAssignmentSchema = Type.Object(
  {
    tenantId: OpaqueIdSchema,
    projectId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    supervisorId: OpaqueIdSchema,
    bootId: UuidSchema,
    sandboxId: UuidSchema,
    runId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    turnId: OpaqueIdSchema,
    executionLease: ExecutionLeaseSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.create"),
    requestId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
    turnContextSha256: Sha256Schema,
    attemptContextSha256: Sha256Schema,
    allowedTools: CloudToolCapabilitySnapshotSchema,
    executionMode: ExecutionModeSchema,
    sandboxProfileKey: DevelopmentEnvironmentProfileKeySchema,
    toolRoot: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    environment: EnvironmentRuntimeSnapshotSchema,
    workspaceSeed: AgentWorkspaceSeedSchema,
    workspaceSettlement: Type.Optional(WorkspaceBlobSchema),
    workspaceRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.reserved"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    executionLease: ExecutionLeaseSchema,
    ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
    workspaceRoot: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
    continuity: Type.Union([Type.Literal("cold_restore"), Type.Literal("warm_reuse")]),
    continuityId: OpaqueIdSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxCreateRedirectResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.owner_redirect"),
    requestId: UuidSchema,
    ownerBaseUrl: Type.String({ minLength: 8, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

export const ToolSandboxCaptureRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.capture"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxCaptureResponseSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.captured"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      settlement: WorkspaceBlobSchema,
      environment: EnvironmentValidationReportSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.unused"),
      requestId: UuidSchema,
      activationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolBrokerWorkspaceForkRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.fork"),
    requestId: UuidSchema,
    sourceActivationId: UuidSchema,
    sourceAssignment: ToolSandboxAssignmentSchema,
    target: Type.Object(
      {
        tenantId: OpaqueIdSchema,
        projectId: OpaqueIdSchema,
        workspaceId: UuidSchema,
        sessionId: UuidSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ToolBrokerWorkspaceForkResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.forked"),
    requestId: UuidSchema,
    sourceActivationId: UuidSchema,
    targetWorkspaceId: UuidSchema,
    sourceSettlementRevision: Sha256Schema,
    targetSettlementRevision: Sha256Schema,
  },
  { additionalProperties: false },
);

export const ToolSandboxReleaseRequestSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("detach"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("keep_warm"),
      workspaceRevision: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.release"),
      requestId: UuidSchema,
      activationId: UuidSchema,
      assignment: ToolSandboxAssignmentSchema,
      disposition: Type.Literal("destroy"),
    },
    { additionalProperties: false },
  ),
]);

export const ToolSandboxReleaseResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.released"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    retained: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ToolSandboxStopRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.stop"),
    requestId: UuidSchema,
    activationId: UuidSchema,
    assignment: ToolSandboxAssignmentSchema,
  },
  { additionalProperties: false },
);

export const ToolSandboxStopResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("tool_sandbox.stopped"),
    requestId: UuidSchema,
    activationId: UuidSchema,
  },
  { additionalProperties: false },
);

const WorkspaceBrowserPathSchema = Type.String({ minLength: 0, maxLength: 512 });

export const ToolBrokerListWorkspaceDirectoryRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.list_directory"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    rootPath: WorkspaceBrowserPathSchema,
    path: WorkspaceBrowserPathSchema,
  },
  { additionalProperties: false },
);

export const ToolBrokerListWorkspaceDirectoryResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.directory_listed"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    path: WorkspaceBrowserPathSchema,
    entries: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 255 }),
          path: Type.String({ minLength: 1, maxLength: 512 }),
          kind: Type.Union([
            Type.Literal("directory"),
            Type.Literal("file"),
            Type.Literal("symlink"),
          ]),
          sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          executable: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4_096 },
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ToolBrokerReadWorkspaceFileRequestSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.read_file"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    sessionId: OpaqueIdSchema,
    rootPath: WorkspaceBrowserPathSchema,
    path: Type.String({ minLength: 1, maxLength: 512 }),
    maximumBytes: Type.Integer({ minimum: 1, maximum: MAX_TOOL_FILE_BYTES }),
  },
  { additionalProperties: false },
);

export const ToolBrokerReadWorkspaceFileResponseSchema = Type.Object(
  {
    ...ToolSandboxEnvelope,
    type: Type.Literal("workspace.file_read"),
    requestId: UuidSchema,
    tenantId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Base64Schema,
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    executable: Type.Boolean(),
    sizeBytes: Type.Integer({ minimum: 0, maximum: MAX_TOOL_FILE_BYTES }),
  },
  { additionalProperties: false },
);

export const ToolBrokerRequestSchema = Type.Union([
  ToolSandboxCreateRequestSchema,
  ToolSandboxCaptureRequestSchema,
  ToolSandboxReleaseRequestSchema,
  ToolSandboxStopRequestSchema,
  ToolBrokerWorkspaceForkRequestSchema,
]);

export const ToolBrokerResponseSchema = Type.Union([
  ToolSandboxCreateResponseSchema,
  ToolSandboxCreateRedirectResponseSchema,
  ToolSandboxCaptureResponseSchema,
  ToolSandboxReleaseResponseSchema,
  ToolSandboxStopResponseSchema,
  ToolBrokerWorkspaceForkResponseSchema,
]);

const OperationEnvelope = {
  ...ToolSandboxEnvelope,
  type: Type.Literal("tool_sandbox.operation"),
  activationId: UuidSchema,
  operationId: UuidSchema,
  turnContextSha256: Sha256Schema,
  attemptContextSha256: Sha256Schema,
  stepContextSequence: PositiveSafeIntegerSchema,
  stepContextSha256: Sha256Schema,
  toolName: CloudToolNameSchema,
};

const ToolPathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

export const ToolSandboxOperationRequestSchema = Type.Union([
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("bash.exec"),
      command: Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES }),
      cwd: ToolPathSchema,
      timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.read"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.read_range"),
      path: ToolPathSchema,
      offsetLine: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
      limitLines: Type.Integer({ minimum: 1, maximum: MAX_TOOL_READ_RANGE_LINES }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.write"),
      path: ToolPathSchema,
      content: Type.String({ maxLength: MAX_TOOL_MUTATION_FILE_BYTES }),
      expectedSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.mkdir"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...OperationEnvelope,
      operation: Type.Literal("file.access"),
      path: ToolPathSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolSandboxOperationResponseSchema = Type.Union([
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("bash.exec"),
      exitCode: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
      outputChunks: Type.Array(ToolOutputChunkSchema, { maxItems: 16_384 }),
      outputSha256: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.read"),
      content: MutationFileBase64Schema,
      sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.read_range"),
      content: Base64Schema,
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 0 }),
      nextOffsetLine: Type.Optional(Type.Integer({ minimum: 1 })),
      firstLineBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Literal("file.write"),
      sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_result"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      operation: Type.Union([Type.Literal("file.mkdir"), Type.Literal("file.access")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ToolSandboxEnvelope,
      type: Type.Literal("tool_sandbox.operation_failed"),
      activationId: UuidSchema,
      operationId: UuidSchema,
      code: SafeCodeSchema,
      message: Type.String({ minLength: 1, maxLength: 512 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export const ToolWorkerInputSchema = Type.Union([
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.initialize"),
      activationId: UuidSchema,
      toolRoot: Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/" }),
      environment: EnvironmentRuntimeSnapshotSchema,
      workspaceSeed: AgentWorkspaceSeedSchema,
      webProxy: Type.Optional(ToolWebProxyBootstrapSchema),
      workspaceAttach: Type.Optional(ToolWorkerWorkspaceAttachSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.operation"),
      request: ToolSandboxOperationRequestSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.cancel"),
      activationId: UuidSchema,
      operationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.shutdown"),
      activationId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ToolWorkerOutputSchema = Type.Union([
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.ready"),
      activationId: UuidSchema,
      environment: EnvironmentToolchainReportSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.operation_result"),
      response: ToolSandboxOperationResponseSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...WorkerEnvelope,
      type: Type.Literal("worker.failed"),
      activationId: Type.Optional(UuidSchema),
      operationId: Type.Optional(UuidSchema),
      code: SafeCodeSchema,
      message: Type.String({ minLength: 1, maxLength: 512 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);

export type ToolSandboxAssignment = Static<typeof ToolSandboxAssignmentSchema>;
export type ToolSandboxCreateRequest = Static<typeof ToolSandboxCreateRequestSchema>;
export type ToolSandboxCreateResponse = Static<typeof ToolSandboxCreateResponseSchema>;
export type ToolSandboxCreateRedirectResponse = Static<
  typeof ToolSandboxCreateRedirectResponseSchema
>;
export type ToolSandboxCaptureRequest = Static<typeof ToolSandboxCaptureRequestSchema>;
export type ToolSandboxCaptureResponse = Static<typeof ToolSandboxCaptureResponseSchema>;
export type ToolSandboxReleaseRequest = Static<typeof ToolSandboxReleaseRequestSchema>;
export type ToolSandboxReleaseResponse = Static<typeof ToolSandboxReleaseResponseSchema>;
export type ToolSandboxStopRequest = Static<typeof ToolSandboxStopRequestSchema>;
export type ToolSandboxStopResponse = Static<typeof ToolSandboxStopResponseSchema>;
export type ToolBrokerWorkspaceForkRequest = Static<typeof ToolBrokerWorkspaceForkRequestSchema>;
export type ToolBrokerWorkspaceForkResponse = Static<typeof ToolBrokerWorkspaceForkResponseSchema>;
export type ToolBrokerListWorkspaceDirectoryRequest = Static<
  typeof ToolBrokerListWorkspaceDirectoryRequestSchema
>;
export type ToolBrokerListWorkspaceDirectoryResponse = Static<
  typeof ToolBrokerListWorkspaceDirectoryResponseSchema
>;
export type ToolBrokerReadWorkspaceFileRequest = Static<
  typeof ToolBrokerReadWorkspaceFileRequestSchema
>;
export type ToolBrokerReadWorkspaceFileResponse = Static<
  typeof ToolBrokerReadWorkspaceFileResponseSchema
>;
export type ToolBrokerRequest = Static<typeof ToolBrokerRequestSchema>;
export type ToolBrokerResponse = Static<typeof ToolBrokerResponseSchema>;
export type ToolSandboxOperationRequest = Static<typeof ToolSandboxOperationRequestSchema>;
export type ToolSandboxOperationResponse = Static<typeof ToolSandboxOperationResponseSchema>;
export type ToolWorkerInput = Static<typeof ToolWorkerInputSchema>;
export type ToolWorkerOutput = Static<typeof ToolWorkerOutputSchema>;
export type ToolWebProxyBootstrap = Static<typeof ToolWebProxyBootstrapSchema>;

export class ToolSandboxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSandboxProtocolError";
  }
}

function parse<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    const issue = [...Value.Errors(schema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new ToolSandboxProtocolError(
      `${label} failed validation at ${location}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return value as T;
}

export function parseToolBrokerRequest(value: unknown): ToolBrokerRequest {
  return parse(ToolBrokerRequestSchema, value, "Tool Broker request");
}

export function parseToolBrokerResponse(value: unknown): ToolBrokerResponse {
  return parse(ToolBrokerResponseSchema, value, "Tool Broker response");
}

export function parseToolBrokerReadWorkspaceFileRequest(
  value: unknown,
): ToolBrokerReadWorkspaceFileRequest {
  return parse(
    ToolBrokerReadWorkspaceFileRequestSchema,
    value,
    "Tool Broker read Workspace file request",
  );
}

export function parseToolBrokerReadWorkspaceFileResponse(
  value: unknown,
): ToolBrokerReadWorkspaceFileResponse {
  return parse(
    ToolBrokerReadWorkspaceFileResponseSchema,
    value,
    "Tool Broker read Workspace file response",
  );
}

export function parseToolBrokerListWorkspaceDirectoryRequest(
  value: unknown,
): ToolBrokerListWorkspaceDirectoryRequest {
  return parse(
    ToolBrokerListWorkspaceDirectoryRequestSchema,
    value,
    "Tool Broker list Workspace directory request",
  );
}

export function parseToolBrokerListWorkspaceDirectoryResponse(
  value: unknown,
): ToolBrokerListWorkspaceDirectoryResponse {
  return parse(
    ToolBrokerListWorkspaceDirectoryResponseSchema,
    value,
    "Tool Broker list Workspace directory response",
  );
}

export function parseToolSandboxOperationRequest(value: unknown): ToolSandboxOperationRequest {
  return parse(ToolSandboxOperationRequestSchema, value, "Tool Sandbox operation request");
}

export function parseToolSandboxOperationResponse(value: unknown): ToolSandboxOperationResponse {
  return parse(ToolSandboxOperationResponseSchema, value, "Tool Sandbox operation response");
}

export function parseToolWorkerInput(value: unknown): ToolWorkerInput {
  return parse(ToolWorkerInputSchema, value, "Tool worker input");
}

export function parseToolWorkerOutput(value: unknown): ToolWorkerOutput {
  return parse(ToolWorkerOutputSchema, value, "Tool worker output");
}
