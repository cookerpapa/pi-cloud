import { Type, type Static } from "typebox";
import { DeepSeekModelIdSchema, OpenAICodexModelIdSchema } from "./control-plane-api.ts";
import { UuidSchema } from "./protocol-primitives.ts";

// Provider-native Workspace settlements carry only a bounded Volume reference.
// Workspace bytes remain in the persistent Provider Volume.
export const MAX_WORKSPACE_BLOB_BYTES = 32 * 1_024 * 1_024;

const MAX_BASE64_WORKSPACE_BLOB_LENGTH = Math.ceil(MAX_WORKSPACE_BLOB_BYTES / 3) * 4;

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const AgentRuntimeKindSchema = Type.Union([Type.Literal("pi_sdk")]);
export const SessionStorageKindSchema = Type.Union([Type.Literal("pi_session_storage_v1")]);

export const AgentRevisionSnapshotSchema = Type.Object(
  {
    revisionId: UuidSchema,
    definitionKey: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
    runtimeKind: AgentRuntimeKindSchema,
    runtimeVersion: Type.String({ minLength: 1, maxLength: 128 }),
    harnessVersion: Type.String({ minLength: 1, maxLength: 128 }),
    sessionStorageKind: SessionStorageKindSchema,
  },
  { additionalProperties: false },
);

const AgentModelRuntimeCommonSchema = {
  kind: Type.Literal("openai_compatible_gateway"),
  baseUrl: Type.String({ minLength: 12, maxLength: 2_048 }),
  capability: Type.String({
    minLength: 100,
    maxLength: 2_048,
    pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$",
  }),
  reasoning: Type.Boolean(),
  contextWindow: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
  maxTokens: Type.Integer({ minimum: 128, maximum: 65_536 }),
  requestTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
  turnTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 900_000 }),
  inputModalities: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  }),
  hostedTools: Type.Array(Type.Union([Type.Literal("web_search")]), {
    maxItems: 1,
    uniqueItems: true,
  }),
};

export const AgentModelRuntimeSchema = Type.Union([
  Type.Object(
    {
      ...AgentModelRuntimeCommonSchema,
      provider: Type.Literal("deepseek"),
      modelId: DeepSeekModelIdSchema,
      api: Type.Literal("openai-responses"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentModelRuntimeCommonSchema,
      provider: Type.Literal("openai-codex"),
      modelId: OpenAICodexModelIdSchema,
      api: Type.Literal("openai-codex-responses"),
    },
    { additionalProperties: false },
  ),
]);

export const WorkspaceBlobSchema = Type.Object(
  {
    encoding: Type.Literal("base64"),
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_WORKSPACE_BLOB_BYTES,
    }),
    data: Type.String({ minLength: 4, maxLength: MAX_BASE64_WORKSPACE_BLOB_LENGTH }),
  },
  { additionalProperties: false },
);

export const AgentWorkspaceSeedSchema = Type.Union([
  Type.Object({ kind: Type.Literal("sample_java") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("bundle"), bundle: WorkspaceBlobSchema },
    { additionalProperties: false },
  ),
]);

export type AgentModelRuntime = Static<typeof AgentModelRuntimeSchema>;
export type AgentModelInputModality = AgentModelRuntime["inputModalities"][number];
export type AgentModelHostedTool = AgentModelRuntime["hostedTools"][number];
export type AgentRevisionSnapshot = Static<typeof AgentRevisionSnapshotSchema>;
export type AgentRuntimeKind = Static<typeof AgentRuntimeKindSchema>;
export type SessionStorageKind = Static<typeof SessionStorageKindSchema>;
export type AgentWorkspaceSeed = Static<typeof AgentWorkspaceSeedSchema>;
export type WorkspaceBlob = Static<typeof WorkspaceBlobSchema>;
