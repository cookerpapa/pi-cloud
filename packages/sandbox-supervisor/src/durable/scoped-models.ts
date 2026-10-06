import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { completeModelResponse, durableModelProgress } from "./model-stream-policy.ts";

type ModelOperation = "stream" | "streamSimple" | "streamDeferred" | "cancelDeferred";
type RequestOptions = Record<string, unknown> & { signal?: AbortSignal };
export type CloudModelPermit = {
  model: Model<Api>;
  options: RequestOptions;
  input?: unknown;
  /** Lossy activity only. Tool names, IDs and arguments never leave this port. */
  onToolCallProgress?(): void;
  decorate?(message: AssistantMessage): void;
  release(): void;
};
export type CloudModelRequest = {
  runId: string;
  operation: ModelOperation;
  input: unknown;
  options: RequestOptions;
};

/** A persisted model reference names logical work, never a boot credential.
 * The public Models boundary resolves the current cloud grant for every call,
 * including Compaction and deferred requests. Hook exceptions are not gates. */
export class ScopedDurableModels {
  readonly models: Models;
  readonly #descriptors = new Map<string, { runId: string; model: Model<Api> }>();
  constructor(
    readonly source: Models,
    readonly open: (request: CloudModelRequest) => Promise<CloudModelPermit>,
  ) {
    this.models = new Proxy(source, {
      get: (target, key) => {
        if (key === "getModel")
          return (provider: string, id: string) => {
            const record = this.#descriptors.get(id);
            return record?.model.provider === provider ? { ...record.model, id } : undefined;
          };
        if (key === "stream" || key === "streamSimple" || key === "streamDeferred")
          return (model: Model<Api>, input: unknown, options: RequestOptions = {}) =>
            this.#stream(key, model, input, options);
        if (key === "complete" || key === "completeSimple" || key === "fetchDeferred") {
          const operation =
            key === "complete"
              ? "stream"
              : key === "completeSimple"
                ? "streamSimple"
                : "streamDeferred";
          return (model: Model<Api>, input: unknown, options: RequestOptions = {}) =>
            this.#stream(operation, model, input, options).result();
        }
        if (key === "cancelDeferred")
          return async (model: Model<Api>, input: unknown, options: RequestOptions = {}) => {
            const permit = await this.#permit("cancelDeferred", model, input, options);
            try {
              await Reflect.apply(target.cancelDeferred, target, [
                permit.model,
                input,
                permit.options,
              ]);
            } finally {
              permit.release();
            }
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  register(runId: string, model: Model<Api>): { provider: string; modelId: string } {
    if (!/^[0-9a-f-]{36}$/.test(runId))
      throw new Error("Model route requires a cloud Run identity");
    const modelId = `pi-cloud:${runId}:${encodeURIComponent(model.id)}`;
    // Even a model-level Authorization header is a live grant, not native state.
    const { headers: _headers, ...descriptor } = model;
    this.#descriptors.set(modelId, { runId, model: descriptor });
    return { provider: model.provider, modelId };
  }
  forget(runId: string): void {
    for (const [key, value] of this.#descriptors)
      if (value.runId === runId) this.#descriptors.delete(key);
  }
  async #permit(
    operation: ModelOperation,
    model: Model<Api>,
    input: unknown,
    options: RequestOptions,
  ): Promise<CloudModelPermit> {
    const descriptor = this.#descriptors.get(model.id);
    if (!descriptor || descriptor.model.provider !== model.provider)
      throw new Error("Cloud model route is not admitted");
    options.signal?.throwIfAborted();
    const permit = await this.open({ runId: descriptor.runId, operation, input, options });
    if (
      permit.model.provider !== descriptor.model.provider ||
      permit.model.id !== descriptor.model.id ||
      permit.model.api !== descriptor.model.api
    ) {
      permit.release();
      throw new Error("Cloud model grant changed the accepted model");
    }
    try {
      permit.options.signal?.throwIfAborted();
    } catch (error) {
      permit.release();
      throw error;
    }
    return permit;
  }
  #stream(
    operation: Exclude<ModelOperation, "cancelDeferred">,
    model: Model<Api>,
    input: unknown,
    options: RequestOptions,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let permit: CloudModelPermit | undefined;
      try {
        permit = await this.#permit(operation, model, input, options);
        const stream = Reflect.apply(this.source[operation], this.source, [
          permit.model,
          permit.input ?? input,
          permit.options,
        ]) as AssistantMessageEventStream;
        let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
        for await (const event of stream) {
          if (event.type === "done" || event.type === "error") terminal = event;
          else {
            const progress = durableModelProgress(event);
            if (progress) output.push(progress);
            else {
              try {
                permit.onToolCallProgress?.();
              } catch {
                /* Disposable activity cannot interrupt model execution. */
              }
            }
          }
        }
        const result = completeModelResponse(await stream.result());
        permit.decorate?.(result);
        const ids = new Set<string>();
        if (
          result.content.some(
            (part) =>
              part.type === "toolCall" &&
              (!part.id || ids.has(part.id) || (ids.add(part.id), false)),
          )
        ) {
          result.stopReason = "error";
          result.content = completeModelResponse(result).content;
          result.errorMessage = "Provider returned ambiguous tool call identities";
          terminal = { type: "error", reason: "error", error: result };
        }
        // Completion can immediately schedule a Tool/Child. Release the model
        // slot before exposing that boundary, not in a later iterator turn.
        const completed = permit;
        permit = undefined;
        completed.release();
        if (terminal)
          output.push(
            terminal.type === "done"
              ? { ...terminal, message: result }
              : { ...terminal, error: result },
          );
        output.end(result);
      } catch {
        const real = this.#descriptors.get(model.id)?.model ?? model;
        const message: AssistantMessage = {
          role: "assistant",
          api: real.api,
          provider: real.provider,
          model: real.id,
          content: [],
          stopReason: options.signal?.aborted ? "aborted" : "error",
          errorMessage: "Cloud model execution permission or transport is unavailable",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
        output.push({
          type: "error",
          reason: message.stopReason as "error" | "aborted",
          error: message,
        });
        output.end(message);
      } finally {
        permit?.release();
      }
    })();
    return output;
  }
}
