import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AgentThinkingLevelSchema } from "./agent-profile.ts";

export const ModelIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const ThinkingSchema = AgentThinkingLevelSchema;
const ProviderSchema = Type.Union([Type.Literal("openai-codex"), Type.Literal("deepseek")]);
const RuntimeProperties = {
  api: Type.Union([Type.Literal("openai-codex-responses"), Type.Literal("openai-responses")]),
  thinkingLevels: Type.Array(ThinkingSchema, { minItems: 1, uniqueItems: true }),
  defaultThinkingLevel: ThinkingSchema,
  fastModeAvailable: Type.Boolean(),
  contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  autoCompactTokenLimit: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  maxTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  inputModalities: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
    minItems: 1,
    uniqueItems: true,
  }),
  hostedTools: Type.Array(Type.Literal("web_search"), { uniqueItems: true }),
};
export const ModelRuntimeSnapshotSchema = Type.Object(
  {
    catalogRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    ...RuntimeProperties,
  },
  { additionalProperties: false },
);
export type ModelRuntimeSnapshot = Static<typeof ModelRuntimeSnapshotSchema>;
export const CatalogModelSchema = Type.Object(
  {
    provider: ProviderSchema,
    modelId: ModelIdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    visible: Type.Boolean(),
    ...RuntimeProperties,
  },
  { additionalProperties: false },
);
export type CatalogModel = Static<typeof CatalogModelSchema>;
export const ModelCatalogConfigurationSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    defaultModel: Type.Object(
      { provider: ProviderSchema, modelId: ModelIdSchema },
      { additionalProperties: false },
    ),
    models: Type.Array(CatalogModelSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ModelCatalogConfiguration = Static<typeof ModelCatalogConfigurationSchema>;

function assertRuntime(value: Omit<ModelRuntimeSnapshot, "catalogRevision">): void {
  if (
    !value.thinkingLevels.includes(value.defaultThinkingLevel) ||
    (value.thinkingLevels.includes("ultra") && !value.thinkingLevels.includes("max")) ||
    !value.inputModalities.includes("text") ||
    value.autoCompactTokenLimit + value.maxTokens > value.contextWindow
  ) {
    throw new TypeError("Invalid model reasoning, modalities or context budget");
  }
}
export function assertModelAdapter(
  provider: string,
  value: Omit<ModelRuntimeSnapshot, "catalogRevision">,
): void {
  assertRuntime(value);
  if (
    !(provider === "openai-codex" && value.api === "openai-codex-responses") &&
    !(provider === "deepseek" && value.api === "openai-responses" && !value.fastModeAvailable)
  ) {
    throw new TypeError("Unsupported model provider adapter");
  }
}
export function parseModelRuntimeSnapshot(value: unknown): ModelRuntimeSnapshot {
  if (!Value.Check(ModelRuntimeSnapshotSchema, value))
    throw new TypeError("Invalid model runtime snapshot");
  assertRuntime(value);
  return structuredClone(value);
}
export function parseModelCatalogConfiguration(value: unknown): ModelCatalogConfiguration {
  if (!Value.Check(ModelCatalogConfigurationSchema, value))
    throw new TypeError("Invalid model catalog configuration");
  const seen = new Set<string>();
  for (const model of value.models) {
    assertModelAdapter(model.provider, model);
    const key = `${model.provider}:${model.modelId}`;
    if (seen.has(key)) throw new TypeError("Duplicate model catalog identity");
    seen.add(key);
  }
  if (
    !value.models.some(
      (m) =>
        m.visible &&
        m.provider === value.defaultModel.provider &&
        m.modelId === value.defaultModel.modelId,
    )
  ) {
    throw new TypeError("The default model must be visible in the catalog");
  }
  return structuredClone(value);
}
