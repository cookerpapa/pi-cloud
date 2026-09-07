/** Reviewed routes only. Transport adapters remain provider-specific. */
const GPT = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
  fastModeAvailable: true,
  contextWindow: 1_000_000,
  autoCompactTokenLimit: 900_000,
  maxTokens: 65_536,
  inputModalities: ["text", "image"],
  hostedTools: ["web_search"],
} as const;
const DEEPSEEK = {
  provider: "deepseek",
  api: "openai-responses",
  thinkingLevels: ["off", "low", "medium", "high", "max"],
  fastModeAvailable: false,
  contextWindow: 128_000,
  autoCompactTokenLimit: 111_616,
  maxTokens: 8_192,
  inputModalities: ["text"],
  hostedTools: ["web_search"],
} as const;

export const REVIEWED_MODELS = [
  {
    ...GPT,
    modelId: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    defaultThinkingLevel: "medium",
  },
  { ...GPT, modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultThinkingLevel: "low" },
  { ...GPT, modelId: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultThinkingLevel: "medium" },
  {
    ...DEEPSEEK,
    modelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    defaultThinkingLevel: "off",
  },
  {
    ...DEEPSEEK,
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    defaultThinkingLevel: "off",
  },
] as const;
for (const model of REVIEWED_MODELS) {
  Object.freeze(model.thinkingLevels);
  Object.freeze(model.inputModalities);
  Object.freeze(model.hostedTools);
  Object.freeze(model);
}
Object.freeze(REVIEWED_MODELS);
export type ReviewedModel = (typeof REVIEWED_MODELS)[number];
export const DEFAULT_NEW_CONVERSATION_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
} as const;
export const reviewedModel = (provider: string, modelId: string): ReviewedModel | undefined =>
  REVIEWED_MODELS.find((model) => model.provider === provider && model.modelId === modelId);
export const DEEPSEEK_MODEL_IDS = REVIEWED_MODELS.filter(
  (m): m is Extract<ReviewedModel, { provider: "deepseek" }> => m.provider === "deepseek",
).map((m) => m.modelId);
export const GPT_MODEL_IDS = REVIEWED_MODELS.filter(
  (m): m is Extract<ReviewedModel, { provider: "openai-codex" }> => m.provider === "openai-codex",
).map((m) => m.modelId);
