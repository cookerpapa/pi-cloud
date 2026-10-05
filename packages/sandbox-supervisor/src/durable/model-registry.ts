import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import * as completions from "@earendil-works/pi-ai/api/openai-completions";
import * as responses from "@earendil-works/pi-ai/api/openai-responses";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiModelRuntimeConfig } from "../pi-turn-runtime.ts";

/** Code-owned provider implementations and credential-free model metadata.
 * A live Run grant supplies authorization only when ScopedDurableModels opens
 * the actual request. No CLI auth store, extension loader or mutable key pool. */
export class CloudModelRegistry {
  readonly models: MutableModels = createModels();
  readonly #models = new Map<string, Model<Api>>();
  configure(config: PiModelRuntimeConfig): Model<Api> {
    const model: Model<Api> = {
      id: config.modelId,
      name: config.modelId,
      api: config.api,
      provider: config.provider,
      baseUrl: config.baseUrl,
      reasoning: config.reasoning ?? false,
      input: [...(config.inputModalities ?? ["text"])],
      contextWindow: config.contextWindow ?? 16384,
      maxTokens: config.maxTokens ?? 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.provider === "deepseek"
        ? {
            thinkingLevelMap: {
              off: "none",
              minimal: "low",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "max",
              max: "max",
            },
            compat: {
              supportsDeveloperRole: false,
              supportsStrictMode: false,
              supportsLongCacheRetention: false,
            },
          }
        : {
            thinkingLevelMap: {
              minimal: "low",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
            compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
          }),
    };
    this.#models.set(`${config.provider}:${config.modelId}`, model);
    this.models.setProvider(
      createProvider({
        id: config.provider,
        name: config.provider,
        // Models 1.0 resolves explicit request keys through the provider's
        // apiKey method. The legacy Codex provider exposes OAuth only; using it
        // here would reject our live cloud capability before any HTTP request.
        auth: {
          apiKey: {
            name: "PiCloud Run capability",
            resolve: async ({ credential, signal }) => {
              signal.throwIfAborted();
              return credential?.key
                ? { auth: { apiKey: credential.key }, source: "cloud grant" }
                : undefined;
            },
          },
        },
        models: [...this.#models.values()].filter(
          (candidate) => candidate.provider === config.provider,
        ),
        api: {
          "openai-completions": completions,
          "openai-responses": responses,
          "openai-codex-responses": codex,
        },
      }),
    );
    return model;
  }
}
