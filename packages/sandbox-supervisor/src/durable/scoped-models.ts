import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { completeModelResponse } from "./model-stream-policy.ts";
import { ProviderResponse } from "./provider-response.ts";
import { withModelWebSocket } from "./model-websocket.ts";
import { MODEL_EVENT_IDLE_MS, ModelEventWait, isModelStreamEvent } from "./model-wait-policy.ts";
import type { ProviderHostedActivity } from "../agent-turn-runtime.ts";

type ModelOperation = "stream" | "streamSimple" | "streamDeferred" | "cancelDeferred";
type RequestOptions = Record<string, unknown> & { signal?: AbortSignal };
export type CloudModelPermit = {
  model: Model<Api>;
  options: RequestOptions;
  input?: unknown;
  eventIdleTimeoutMs?: number;
  /** Lossy activity only. Tool names, IDs and arguments never leave this port. */
  onToolCallProgress?(): void;
  onHostedActivity?(activity: ProviderHostedActivity): void;
  onOutcome?(sample: {
    outcome: "completed" | "error" | "aborted" | "deferred";
    startedAtMs: number;
    startedMonotonicMs: number;
    processStartedAtMs: number;
    durationMs: number;
    firstFrameMs?: number;
    firstTextMs?: number;
    firstToolMs?: number;
    firstSearchMs?: number;
    failureCause?:
      "event_idle_timeout" | "cancelled" | "provider_error" | "response_processing_error";
  }): void;
  release(): void;
};
export type CloudModelRequest = {
  runId: string;
  conversationId: number;
  operation: ModelOperation;
  input: unknown;
  options: RequestOptions;
};

/** A persisted model reference names logical work, never a boot credential.
 * The public Models boundary resolves the current cloud grant for every call,
 * including Compaction and deferred requests. Hook exceptions are not gates. */
export class ScopedDurableModels {
  readonly models: Models;
  readonly #descriptors = new Map<
    string,
    { runId: string; conversationId: number; model: Model<Api> }
  >();
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
  register(
    runId: string,
    conversationId: number,
    model: Model<Api>,
  ): { provider: string; modelId: string } {
    if (
      !/^[0-9a-f-]{36}$/.test(runId) ||
      !Number.isSafeInteger(conversationId) ||
      conversationId < 1
    )
      throw new Error("Model route requires a cloud Run and native Conversation identity");
    const modelId = `pi-cloud:${runId}:${conversationId}:${encodeURIComponent(model.id)}`;
    // Even a model-level Authorization header is a live grant, not native state.
    const { headers: _headers, ...descriptor } = model;
    this.#descriptors.set(modelId, { runId, conversationId, model: descriptor });
    return { provider: model.provider, modelId };
  }
  forget(runId: string, conversationId: number): void {
    for (const [key, value] of this.#descriptors)
      if (value.runId === runId && value.conversationId === conversationId)
        this.#descriptors.delete(key);
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
    const permit = await this.open({
      runId: descriptor.runId,
      conversationId: descriptor.conversationId,
      operation,
      input,
      options,
    });
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
      let response: ProviderResponse | undefined;
      let sourceStream: AssistantMessageEventStream | undefined;
      const requestLifetime = new AbortController();
      let eventWait: ModelEventWait | undefined;
      let ownerSignal: AbortSignal | undefined;
      let providerResult = false;
      let report: ((outcome: "completed" | "error" | "aborted" | "deferred") => void) | undefined;
      try {
        permit = await this.#permit(operation, model, input, options);
        ownerSignal = permit.options.signal;
        const startedAt = performance.now();
        const startedAtMs = Date.now();
        const observe = permit.onOutcome;
        let reported = false;
        report = (outcome) => {
          if (reported) return;
          reported = true;
          try {
            observe?.({
              outcome,
              startedAtMs,
              startedMonotonicMs: response?.startedAt ?? startedAt,
              processStartedAtMs: performance.timeOrigin,
              durationMs: performance.now() - startedAt,
              ...response?.timing,
              ...(outcome === "aborted"
                ? { failureCause: "cancelled" as const }
                : outcome === "error"
                  ? {
                      failureCause: eventWait?.expired
                        ? ("event_idle_timeout" as const)
                        : providerResult
                          ? ("provider_error" as const)
                          : ("response_processing_error" as const),
                    }
                  : {}),
            });
          } catch {
            /* Telemetry is not an execution authority. */
          }
        };
        response = new ProviderResponse(
          permit.model,
          (event) => output.push(event),
          permit.onHostedActivity,
        );
        let status: number | undefined;
        const previousResponse = permit.options.onResponse as
          | ((
              value: { status: number; headers: Record<string, string> },
              model: Model<Api>,
            ) => void | Promise<void>)
          | undefined;
        const previous = permit.options.onProviderStreamEvent as
          ((event: unknown, model: Model<Api>) => void | Promise<void>) | undefined;
        eventWait = new ModelEventWait(permit.eventIdleTimeoutMs ?? MODEL_EVENT_IDLE_MS, () =>
          requestLifetime.abort(new Error("Model response event inactivity deadline")),
        );
        const requestPermit = permit;
        const stream = (sourceStream = withModelWebSocket(
          requestPermit.model,
          requestPermit.options,
          () =>
            Reflect.apply(this.source[operation], this.source, [
              requestPermit.model,
              requestPermit.input ?? input,
              {
                ...requestPermit.options,
                // Codex SSE accepts zero as disabled. The OpenAI SDK used by the
                // Responses adapter treats zero as immediate expiry; its header-only
                // fallback must outlive our initial-event deadline instead.
                timeoutMs:
                  requestPermit.model.api === "openai-responses" ||
                  requestPermit.model.api === "openai-completions"
                    ? (requestPermit.eventIdleTimeoutMs ?? MODEL_EVENT_IDLE_MS) + 30_000
                    : 0,
                maxRetries: 0,
                signal: requestPermit.options.signal
                  ? AbortSignal.any([requestPermit.options.signal, requestLifetime.signal])
                  : requestLifetime.signal,
                onResponse: async (
                  value: { status: number; headers: Record<string, string> },
                  real: Model<Api>,
                ) => {
                  status = value.status;
                  await previousResponse?.(value, real);
                },
                onProviderStreamEvent: async (event: unknown, real: Model<Api>) => {
                  if (isModelStreamEvent(event)) eventWait?.touch();
                  response!.observe(event);
                  await previous?.(event, real);
                },
              },
            ]) as AssistantMessageEventStream,
        ));
        let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
        for await (const event of stream) {
          if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type))
            eventWait.touch();
          if (event.type === "done" || event.type === "error") terminal = event;
          else {
            response.progress(event);
            if (
              event.type === "toolcall_start" ||
              event.type === "toolcall_delta" ||
              event.type === "toolcall_end"
            ) {
              try {
                permit.onToolCallProgress?.();
              } catch {
                /* Disposable activity cannot interrupt model execution. */
              }
            }
          }
        }
        const nativeResult = await stream.result();
        providerResult = true;
        eventWait.close();
        const cancelled = options.signal?.aborted || ownerSignal?.aborted;
        const result = completeModelResponse(
          response.result(
            eventWait.expired
              ? {
                  ...nativeResult,
                  stopReason: cancelled ? "aborted" : "error",
                  errorMessage: cancelled ? "Model request was cancelled" : eventWait.message,
                }
              : nativeResult,
          ),
        );
        if (eventWait.expired)
          terminal = { type: "error", reason: cancelled ? "aborted" : "error", error: result };
        if (
          result.stopReason === "error" &&
          ((status !== undefined && status >= 500 && status <= 599) || response.transientFailure)
        ) {
          const errorMessage = `Model provider server error${status && status >= 500 ? ` (HTTP ${status})` : ""}: ${result.errorMessage ?? "upstream failure"}`;
          // Preserve Pi's own terminal quota/billing exclusions even when an
          // upstream misuses a server status. This is classification, not retry.
          if (isRetryableAssistantError({ ...result, errorMessage }))
            result.errorMessage = errorMessage;
        }
        const ids = new Set<string>();
        if (
          result.stopReason === "pending" ||
          result.content.some(
            (part) =>
              part.type === "toolCall" &&
              (!part.id || ids.has(part.id) || (ids.add(part.id), false)),
          )
        ) {
          result.stopReason = "error";
          result.content = completeModelResponse(result).content;
          result.errorMessage =
            "Provider returned an incomplete response or ambiguous Tool identities";
          terminal = { type: "error", reason: "error", error: result };
        }
        // Completion can immediately schedule a Tool/Child. Release the model
        // slot before exposing that boundary, not in a later iterator turn.
        const completed = permit;
        permit = undefined;
        completed.release();
        report(
          result.stopReason === "aborted"
            ? "aborted"
            : result.stopReason === "error"
              ? "error"
              : result.stopReason === "deferred"
                ? "deferred"
                : "completed",
        );
        if (terminal)
          output.push(
            terminal.type === "done"
              ? { ...terminal, message: result }
              : { ...terminal, error: result },
          );
        output.end(result);
      } catch {
        requestLifetime.abort();
        // The fixed adapters honor AbortSignal. Join provider cleanup before
        // releasing its concurrency slot, including local interpretation errors.
        await sourceStream?.result().catch(() => undefined);
        const real = this.#descriptors.get(model.id)?.model ?? model;
        const cancelled = options.signal?.aborted || ownerSignal?.aborted;
        const failureMessage =
          eventWait?.expired && !cancelled
            ? eventWait.message
            : "Cloud model response processing is unavailable";
        const message: AssistantMessage = response?.failure(
          cancelled ? "aborted" : "error",
          failureMessage,
        ) ?? {
          role: "assistant",
          api: real.api,
          provider: real.provider,
          model: real.id,
          content: [],
          stopReason: cancelled ? "aborted" : "error",
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
        report?.(message.stopReason === "aborted" ? "aborted" : "error");
        output.end(message);
      } finally {
        eventWait?.close();
        response?.close("failed");
        permit?.release();
      }
    })();
    return output;
  }
}
