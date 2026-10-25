import { Type, type Static } from "typebox";
import { DeepSeekModelIdSchema, OpenAICodexModelIdSchema } from "./control-plane-api.ts";
import { UuidSchema } from "./protocol-primitives.ts";

export const AgentRuntimeKindSchema = Type.Union([Type.Literal("pi_sdk")]);
export const SessionStorageKindSchema = Type.Union([Type.Literal("pi_durable_storage_v1")]);

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
  autoCompactTokenLimit: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
  maxTokens: Type.Integer({ minimum: 128, maximum: 65_536 }),
  eventIdleTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 900_000 }),
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
      serviceTier: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...AgentModelRuntimeCommonSchema,
      provider: Type.Literal("openai-codex"),
      modelId: OpenAICodexModelIdSchema,
      api: Type.Literal("openai-codex-responses"),
      serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
    },
    { additionalProperties: false },
  ),
]);

export type AgentModelRuntime = Static<typeof AgentModelRuntimeSchema>;
export type AgentModelInputModality = AgentModelRuntime["inputModalities"][number];
export type AgentModelHostedTool = AgentModelRuntime["hostedTools"][number];
export type AgentRevisionSnapshot = Static<typeof AgentRevisionSnapshotSchema>;
export type AgentRuntimeKind = Static<typeof AgentRuntimeKindSchema>;
export type SessionStorageKind = Static<typeof SessionStorageKindSchema>;
