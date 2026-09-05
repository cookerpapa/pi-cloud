import {
  Agent,
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  compact,
  convertToLlm,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CompactionPreparation,
  type CompactionSettings,
  type CustomEntryContextMessageProjector,
  type Entry,
  type LaneRecord,
  type NewRecord,
  type Session,
  type StreamFn,
  type ThinkingLevel,
  type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  Models,
  RetryPolicy,
  SimpleStreamOptions,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExecutionAuthority } from "./execution-authority.ts";
import type { PiSessionMutationOperation, PiSessionAppendOperation } from "./session-mutation.ts";

export const PI_MODEL_RETRY_CUSTOM_TYPE = "pi-cloud.model_retry";

export interface CloudAgentExecutionAuthority extends ExecutionAuthority {
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export type CloudAgentRuntimeEvent =
  | AgentEvent
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: "threshold" }
  | {
      type: "compaction_end";
      reason: "threshold";
      success: boolean;
      errorMessage?: string;
      result?: Readonly<{
        summary: string;
        tokensBefore: number;
        estimatedTokensAfter: number;
      }>;
    };

export type CloudAgentRuntimeOptions = Readonly<{
  session: Session;
  lane: string;
  authority: CloudAgentExecutionAuthority;
  model: Model<Api>;
  models?: Models;
  streamFn?: StreamFn;
  systemPrompt: string | (() => string | Promise<string>);
  tools?: readonly AgentTool[];
  thinkingLevel?: ThinkingLevel;
  streamOptions?: SimpleStreamOptions;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  toolExecution?: ToolExecutionMode;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  prepareContextMaintenance?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<void>;
  transformHeaders?: (
    headers: Record<string, string | null>,
  ) => Record<string, string | null> | Promise<Record<string, string | null>>;
  transformProviderPayload?: (
    payload: unknown,
    context: Context,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  decorateAssistantMessage?: (message: AssistantMessage) => void | Promise<void>;
  entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
  compactionRetainedCustomTypes?: readonly string[];
  prepareFollowUp?: () => AgentMessage | undefined | Promise<AgentMessage | undefined>;
  commitCheckpoint?: (
    operation: PiSessionMutationOperation,
    sourceEvent?: CloudAgentRuntimeEvent,
  ) => Promise<void>;
  onEvent?: (event: CloudAgentRuntimeEvent) => Promise<void> | void;
  idGenerator?: () => string;
}>;

export type CloudAgentRunResult = Readonly<{
  kind: "completed" | "aborted" | "failed";
  finalMessage: AssistantMessage;
  leafId: string;
  error?: Readonly<{ code: string; message: string }>;
}>;

const INTERRUPTION_CUSTOM_TYPE = "pi-cloud.run_interrupted";
const INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE = "pi-cloud.interrupted_assistant_prefix";
const UNKNOWN_TOOL_EFFECT_TEXT =
  "The previous Worker stopped while this Tool was active. Its side effects are unknown. " +
  "Do not replay it blindly; inspect the Workspace and environment before continuing.";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createUserMessage(text: string, images?: readonly ImageContent[]): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
  };
}

function normalizeMessage(message: AgentMessage): AgentMessage {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isObject(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (candidate !== undefined) result[key] = visit(candidate);
    }
    return result;
  };
  return visit(message) as AgentMessage;
}

function hasVisibleAssistantPrefix(message: AssistantMessage): boolean {
  return message.content.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0,
  );
}

function combinedSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second]);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(settle, milliseconds);
    timer.unref();
    const abort = (): void => settle(signal.reason);
    function settle(error?: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function operationError(error: unknown): { code: string; message: string } {
  const normalized = asError(error);
  return { code: normalized.name || "execution_failed", message: normalized.message };
}

function interruptionProjector(entry: {
  customType: string;
  data?: unknown;
  timestamp: number;
}): AgentMessage[] | undefined {
  if (entry.customType !== INTERRUPTION_CUSTOM_TYPE || !isObject(entry.data)) return undefined;
  const content = entry.data.content;
  if (typeof content !== "string" || content.length === 0) return undefined;
  return [
    {
      role: "custom",
      customType: INTERRUPTION_CUSTOM_TYPE,
      content,
      display: false,
      timestamp: entry.timestamp,
    } as AgentMessage,
  ];
}

function interruptedAssistantPrefixProjector(entry: {
  customType: string;
  data?: unknown;
  timestamp: number;
}): AgentMessage[] | undefined {
  if (
    entry.customType !== INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE ||
    !isObject(entry.data) ||
    typeof entry.data.text !== "string" ||
    entry.data.text.length === 0
  ) {
    return undefined;
  }
  return [
    {
      role: "custom",
      customType: INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE,
      content: [
        "<interrupted_assistant_output>",
        entry.data.text,
        "</interrupted_assistant_output>",
      ].join("\n"),
      display: false,
      timestamp: entry.timestamp,
    } as AgentMessage,
  ];
}

function recoveryMarker(reason: string): string {
  return [
    "<turn_aborted>",
    "The previous agent Run did not finish normally.",
    `Reason: ${reason}`,
    "Treat unfinished work as uncertain and inspect relevant state before continuing.",
    "</turn_aborted>",
  ].join("\n");
}

function retainedCustomType(message: AgentMessage, types: ReadonlySet<string>): string | undefined {
  if (message.role !== "custom" || !types.has(message.customType)) return undefined;
  return message.customType;
}

function preserveCompactionFacts(
  preparation: CompactionPreparation,
  context: readonly AgentMessage[],
  customTypes: readonly string[],
): typeof preparation {
  const retainedTypes = new Set(customTypes);
  if (retainedTypes.size === 0) return preparation;

  const latest = new Map<string, AgentMessage>();
  for (const message of context) {
    const customType = retainedCustomType(message, retainedTypes);
    if (customType === undefined) continue;
    latest.delete(customType);
    latest.set(customType, message);
  }
  if (latest.size === 0) return preparation;

  const ordinary = (messages: readonly AgentMessage[]): AgentMessage[] =>
    messages.filter((message) => retainedCustomType(message, retainedTypes) === undefined);
  return {
    ...preparation,
    messagesToSummarize: ordinary(preparation.messagesToSummarize),
    turnPrefixMessages: ordinary(preparation.turnPrefixMessages),
    retainedTail: [...latest.values(), ...ordinary(preparation.retainedTail)],
  };
}

/**
 * Product-sized Pi runtime for one cloud Run.
 *
 * PostgreSQL SessionStorage owns model context; Pi Agent owns only the active
 * in-memory loop. Complete messages are appended on message_end, while remote
 * Tools and Session writes share one opaque authority. The caller owns that
 * authority's lifetime so it can remain valid through Workspace and terminal
 * settlement after this in-memory loop stops.
 */
export class CloudAgentRuntime {
  readonly #options: CloudAgentRuntimeOptions;
  readonly #id: () => string;
  readonly #compaction: CompactionSettings;
  #agent: Agent | undefined;
  #closed = false;

  constructor(options: CloudAgentRuntimeOptions) {
    if (options.models === undefined && options.streamFn === undefined) {
      throw new TypeError("CloudAgentRuntime requires Pi Models or a streamFn");
    }
    this.#options = options;
    this.#id = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#compaction = { ...(options.compaction ?? DEFAULT_COMPACTION_SETTINGS) };
  }

  async run(text: string, images?: readonly ImageContent[]): Promise<CloudAgentRunResult> {
    if (this.#closed) throw new Error("Cloud Agent Runtime is closed");
    if (this.#agent !== undefined) throw new Error("Cloud Agent Runtime is already active");
    if (text.trim().length === 0) throw new TypeError("Cloud Agent prompt must not be empty");

    const authority = this.#options.authority;
    const session = this.#options.session;
    const lane = this.#options.lane;
    const tree = session.view(lane);
    const operationId = this.#id();
    const userMessage = normalizeMessage(createUserMessage(text, images));
    const userEntryId = this.#id();
    let finalMessage: AssistantMessage | undefined;
    let removeAuthorityAbort: (() => void) | undefined;

    try {
      await authority.assertCurrent();
      await this.#recoverInterruptedOperation();
      await this.#appendItems([
        {
          kind: "append_record",
          record: {
            id: operationId,
            lane,
            type: "operation_started",
            sourceLeafId: await tree.getLeafId(),
            intent: {
              kind: "run",
              originalPrompt: [userMessage],
              initialMessages: [{ id: userEntryId, type: "message", message: userMessage }],
            },
          },
        },
        {
          kind: "append_entry",
          entry: { id: userEntryId, type: "message", message: userMessage },
          lane,
        },
      ]);

      let initialPath: Entry[] | undefined = await this.#loadBranch();
      const restored = this.#context(initialPath);
      const systemPrompt =
        typeof this.#options.systemPrompt === "function"
          ? await this.#options.systemPrompt()
          : this.#options.systemPrompt;
      const resultEntryIds = new Map<string, string>();
      let assistantEntryId: string | undefined;
      let pendingAssistantEntryId: string | undefined;
      let deferredAssistantEntryId: string | undefined;
      let assistantAttempt = 0;
      let toolIndex = 0;

      const tools = (this.#options.tools ?? []).map((tool) =>
        this.#bindTool(
          tool,
          operationId,
          resultEntryIds,
          () => assistantEntryId,
          () => toolIndex++,
        ),
      );
      const streamFn: StreamFn = async (model, context, options) => {
        await authority.assertCurrent();
        assistantAttempt += 1;
        pendingAssistantEntryId = this.#id();
        await session.appendRecord({
          id: this.#id(),
          lane,
          type: "step_attempt",
          runId: operationId,
          step: "assistant",
          attempt: assistantAttempt,
          resultEntryId: pendingAssistantEntryId,
        });
        const headers = {
          ...(this.#options.streamOptions?.headers ?? {}),
          ...(options?.headers ?? {}),
        };
        const transformedHeaders = await this.#options.transformHeaders?.(headers);
        const effectiveOptions: SimpleStreamOptions = {
          ...options,
          ...this.#options.streamOptions,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          headers: transformedHeaders ?? headers,
        };
        const callerOnPayload = effectiveOptions.onPayload;
        if (this.#options.transformProviderPayload !== undefined) {
          effectiveOptions.onPayload = async (payload, targetModel) => {
            const callerResult = await callerOnPayload?.(payload, targetModel);
            return this.#options.transformProviderPayload!(
              callerResult ?? payload,
              context,
              targetModel,
            );
          };
        }
        return (
          this.#options.streamFn?.(model, context, effectiveOptions) ??
          this.#options.models!.streamSimple(model, context, effectiveOptions)
        );
      };

      const agent = new Agent({
        streamFn,
        initialState: {
          systemPrompt,
          model: this.#options.model,
          thinkingLevel: this.#options.thinkingLevel ?? "off",
          messages: restored,
          tools,
        },
        convertToLlm,
        transformContext: async (_messages, signal) => {
          const path = initialPath ?? (await this.#loadBranch());
          initialPath = undefined;
          const current = await this.#compactIfNeeded(operationId, path, signal);
          return this.#options.transformContext
            ? this.#options.transformContext(current, signal)
            : current;
        },
        toolExecution: this.#options.toolExecution ?? "sequential",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      });
      this.#agent = agent;
      const abortForAuthority = (): void => agent.abort();
      authority.signal.addEventListener("abort", abortForAuthority, { once: true });
      removeAuthorityAbort = () => authority.signal.removeEventListener("abort", abortForAuthority);
      if (authority.signal.aborted) abortForAuthority();

      const unsubscribe = agent.subscribe(async (event) => {
        let checkpointHandledEvent = false;
        if (event.type === "message_end") {
          initialPath = undefined;
          await authority.assertCurrent();
          if (event.message.role === "assistant") {
            await this.#options.decorateAssistantMessage?.(event.message);
          }
          const message = normalizeMessage(event.message);
          let entryId: string;
          if (message.role === "assistant") {
            entryId = pendingAssistantEntryId ?? this.#id();
            pendingAssistantEntryId = undefined;
          } else if (message.role === "toolResult") {
            entryId = resultEntryIds.get(message.toolCallId) ?? this.#id();
          } else {
            entryId = this.#id();
          }
          const durableMessage =
            message.role !== "assistant" ||
            (message.stopReason !== "error" && message.stopReason !== "aborted");
          if (durableMessage && (await session.getEntry(entryId)) === undefined) {
            const usageRecord = this.#usageRecord(operationId, entryId, message, assistantAttempt);
            if (this.#options.commitCheckpoint === undefined) {
              await session.appendEntry({ id: entryId, type: "message", message }, lane);
              if (usageRecord !== undefined) await session.appendRecord(usageRecord);
            } else {
              await this.#options.commitCheckpoint(
                {
                  kind: "append_items",
                  items: [
                    {
                      kind: "append_entry",
                      entry: { id: entryId, type: "message", message },
                      lane,
                    },
                    ...(usageRecord === undefined
                      ? []
                      : [{ kind: "append_record" as const, record: usageRecord }]),
                  ],
                },
                event,
              );
              checkpointHandledEvent = true;
            }
          }
          if (message.role === "assistant") {
            assistantEntryId = durableMessage ? entryId : undefined;
            deferredAssistantEntryId = durableMessage ? undefined : entryId;
            finalMessage = message;
            toolIndex = 0;
          }
        }
        if (
          !checkpointHandledEvent &&
          !(event.type === "tool_execution_start" && this.#options.commitCheckpoint !== undefined)
        ) {
          await this.#options.onEvent?.(event);
        }
        if (
          event.type === "turn_end" &&
          event.toolResults.length === 0 &&
          event.message.role === "assistant" &&
          event.message.stopReason !== "error" &&
          event.message.stopReason !== "aborted"
        ) {
          const followUp = await this.#options.prepareFollowUp?.();
          if (followUp !== undefined) agent.followUp(followUp);
        }
      });

      try {
        const retry = this.#options.retry;
        let retryAttempt = 0;
        for (;;) {
          await agent.continue();
          if (
            finalMessage?.stopReason !== "error" ||
            retry?.enabled !== true ||
            retryAttempt >= retry.maxRetries ||
            !isRetryableAssistantError(finalMessage)
          ) {
            if (retryAttempt > 0) {
              await this.#options.onEvent?.({
                type: "auto_retry_end",
                success: finalMessage?.stopReason !== "error",
                attempt: retryAttempt,
                ...(finalMessage?.stopReason === "error" && finalMessage.errorMessage
                  ? { finalError: finalMessage.errorMessage }
                  : {}),
              });
            }
            break;
          }

          retryAttempt += 1;
          const delayMs = retry.baseDelayMs * 2 ** (retryAttempt - 1);
          await this.#options.onEvent?.({
            type: "auto_retry_start",
            attempt: retryAttempt,
            maxAttempts: retry.maxRetries,
            delayMs,
            errorMessage: finalMessage.errorMessage ?? "Transient model request failed",
          });
          const failed = agent.state.messages.at(-1);
          if (failed?.role !== "assistant" || failed.stopReason !== "error") {
            throw new Error("Pi retry boundary did not end with a failed assistant message");
          }
          agent.state.messages = agent.state.messages.slice(0, -1);
          finalMessage = undefined;
          await abortableDelay(delayMs, authority.signal);
        }
      } finally {
        unsubscribe();
      }
      await authority.assertCurrent();
      if (finalMessage === undefined) {
        throw new Error("Pi Agent Loop settled without an assistant message");
      }
      const kind =
        finalMessage.stopReason === "aborted"
          ? "aborted"
          : finalMessage.stopReason === "error"
            ? "failed"
            : "completed";
      if (kind !== "completed") {
        if (
          deferredAssistantEntryId !== undefined &&
          hasVisibleAssistantPrefix(finalMessage) &&
          (await session.getEntry(deferredAssistantEntryId)) === undefined
        ) {
          await session.appendEntry(
            { id: deferredAssistantEntryId, type: "message", message: finalMessage },
            lane,
          );
          await this.#recordUsage(
            operationId,
            deferredAssistantEntryId,
            finalMessage,
            assistantAttempt,
          );
        }
        await tree.appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
          content: recoveryMarker(
            kind === "failed"
              ? (finalMessage.errorMessage ?? "Model request failed")
              : "The Run was aborted",
          ),
        });
      }
      await session.appendRecord({
        id: this.#id(),
        lane,
        type: "operation_finished",
        runId: operationId,
        outcome: kind,
        ...(kind === "failed"
          ? {
              error: {
                code: "model_error",
                message: finalMessage.errorMessage ?? "Model request failed",
              },
            }
          : {}),
      });
      const leafId = await tree.getLeafId();
      if (leafId === null) throw new Error("Cloud Agent Session did not produce a leaf");
      return {
        kind,
        finalMessage,
        leafId,
        ...(kind === "failed"
          ? {
              error: {
                code: "model_error",
                message: finalMessage.errorMessage ?? "Model request failed",
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      const failure = operationError(error);
      if (!authority.signal.aborted) {
        await tree
          .appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
            content: recoveryMarker(failure.message),
          })
          .catch(() => undefined);
        await session
          .appendRecord({
            id: this.#id(),
            lane,
            type: "operation_finished",
            runId: operationId,
            outcome: "failed",
            error: failure,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      removeAuthorityAbort?.();
      this.#agent = undefined;
      this.#closed = true;
    }
  }

  steer(text: string): void {
    if (text.trim().length === 0 || text.length > 100_000) {
      throw new TypeError("Steer text is invalid");
    }
    if (this.#agent === undefined) throw new Error("Cloud Agent Run is not active");
    this.#agent.steer(createUserMessage(text));
  }

  abort(): void {
    this.#agent?.abort();
  }

  async #loadContext(): Promise<AgentMessage[]> {
    return this.#context(await this.#loadBranch());
  }

  async #appendItems(items: readonly PiSessionAppendOperation[]): Promise<void> {
    if (this.#options.commitCheckpoint !== undefined) {
      await this.#options.commitCheckpoint({ kind: "append_items", items });
      return;
    }
    for (const item of items) {
      if (item.kind === "append_entry")
        await this.#options.session.appendEntry(item.entry, item.lane);
      else await this.#options.session.appendRecord(item.record);
    }
  }

  async #loadBranch(): Promise<Entry[]> {
    return (
      await this.#options.session
        .view(this.#options.lane)
        .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" })
    ).reverse();
  }

  #context(path: Entry[]): AgentMessage[] {
    const entryProjectors = {
      [INTERRUPTION_CUSTOM_TYPE]: interruptionProjector,
      [INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE]: interruptedAssistantPrefixProjector,
      ...(this.#options.entryProjectors ?? {}),
    } as Readonly<Record<string, CustomEntryContextMessageProjector>>;
    return buildSessionContext(path, { entryProjectors }).messages;
  }

  async #compactIfNeeded(
    operationId: string,
    path: Entry[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const context = this.#context(path);
    if (!this.#compaction.enabled) return context;
    const tokens = estimateContextTokens(context).tokens;
    if (!shouldCompact(tokens, this.#options.model.contextWindow, this.#compaction)) return context;
    const preparation = prepareCompaction(path, this.#compaction);
    if (!preparation.ok) throw preparation.error;
    if (preparation.value === undefined) return context;

    await this.#options.prepareContextMaintenance?.(context, signal);

    await this.#options.onEvent?.({ type: "compaction_start", reason: "threshold" });
    const entryId = this.#id();
    const attempts = await this.#options.session.findRecords({
      lane: this.#options.lane,
      type: "step_attempt",
      runId: operationId,
    });
    const attempt = attempts.filter((record) => record.step === "compaction").length + 1;
    await this.#options.session.appendRecord({
      id: this.#id(),
      lane: this.#options.lane,
      type: "step_attempt",
      runId: operationId,
      step: "compaction",
      attempt,
      resultEntryId: entryId,
      compactionReason: "threshold",
    });
    const compactionModels = this.#modelsWithHeaders();
    const compactable = preserveCompactionFacts(preparation.value, context, [
      INTERRUPTION_CUSTOM_TYPE,
      ...(this.#options.compactionRetainedCustomTypes ?? []),
    ]);
    const result = await compact(
      compactable,
      compactionModels,
      this.#options.model,
      undefined,
      combinedSignal(signal, this.#options.authority.signal),
      this.#options.thinkingLevel ?? "off",
      this.#options.retry,
    );
    if (!result.ok) {
      await this.#options.onEvent?.({
        type: "compaction_end",
        reason: "threshold",
        success: false,
        errorMessage: result.error.message,
      });
      throw result.error;
    }
    await this.#appendItems([
      {
        kind: "append_entry",
        lane: this.#options.lane,
        entry: {
          id: entryId,
          type: "compaction",
          summary: result.value.summary,
          retainedTail: result.value.retainedTail,
          tokensBefore: result.value.tokensBefore,
          ...(result.value.details === undefined ? {} : { details: result.value.details }),
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        },
      },
      ...(result.value.usage === undefined
        ? []
        : [
            {
              kind: "append_record" as const,
              record: {
                id: this.#id(),
                lane: this.#options.lane,
                type: "usage" as const,
                cause: "compaction" as const,
                runId: operationId,
                entryId,
                attempt,
                stopReason: "stop" as const,
                usage: result.value.usage,
              },
            },
          ]),
    ]);
    const compactedContext = await this.#loadContext();
    // Provider usage on an assistant retained by compaction still describes the
    // pre-compaction request.  estimateContextTokens() intentionally trusts that
    // usage for threshold decisions, so it is not a valid post-compaction size
    // metric until the next assistant response replaces it.  Estimate every
    // materialized message structurally for the completion event instead.
    const estimatedTokensAfter = compactedContext.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    );
    await this.#options.onEvent?.({
      type: "compaction_end",
      reason: "threshold",
      success: true,
      result: {
        summary: result.value.summary,
        tokensBefore: result.value.tokensBefore,
        estimatedTokensAfter,
      },
    });
    return compactedContext;
  }

  #modelsWithHeaders(): Models {
    const models = this.#options.models;
    if (models === undefined) {
      throw new Error("Automatic compaction requires Pi Models");
    }
    const transformHeaders = this.#options.transformHeaders;
    if (transformHeaders === undefined) return models;
    return new Proxy(models, {
      get(target, property, receiver) {
        if (property !== "completeSimple") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (
          model: Model<Api>,
          context: Parameters<Models["completeSimple"]>[1],
          options?: SimpleStreamOptions,
        ) => {
          const headers = await transformHeaders({ ...(options?.headers ?? {}) });
          return target.completeSimple(model, context, { ...options, headers });
        };
      },
    });
  }

  #bindTool(
    tool: AgentTool,
    operationId: string,
    resultEntryIds: Map<string, string>,
    assistantEntryId: () => string | undefined,
    nextToolIndex: () => number,
  ): AgentTool {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const authority = this.#options.authority;
        await authority.assertCurrent();
        const durableAssistantEntryId = assistantEntryId();
        if (durableAssistantEntryId === undefined) {
          throw new Error("Tool execution started before its assistant message was durable");
        }
        const resultEntryId = this.#id();
        resultEntryIds.set(toolCallId, resultEntryId);
        const intent: NewRecord<LaneRecord> = {
          id: this.#id(),
          lane: this.#options.lane,
          type: "tool_started",
          runId: operationId,
          assistantEntryId: durableAssistantEntryId,
          toolIndex: nextToolIndex(),
          toolCallId,
          toolName: tool.name,
          effectiveArgs: isObject(params) ? structuredClone(params) : {},
          resultEntryId,
          replay: "never",
        };
        if (this.#options.commitCheckpoint === undefined) {
          await this.#options.session.appendRecord(intent);
        } else {
          await this.#options.commitCheckpoint(
            { kind: "append_items", items: [{ kind: "append_record", record: intent }] },
            {
              type: "tool_execution_start",
              toolCallId,
              toolName: tool.name,
              args: params,
            },
          );
        }
        const result = await tool.execute(
          toolCallId,
          params,
          combinedSignal(signal, authority.signal),
          onUpdate,
        );
        await authority.assertCurrent();
        return result;
      },
    };
  }

  async #recoverInterruptedOperation(): Promise<void> {
    const session = this.#options.session;
    const lane = this.#options.lane;
    const tree = session.view(lane);
    const open = await session.findOpenOperations(lane, { limit: 2 });
    if (open.length > 1) throw new Error("Pi Session contains multiple unfinished operations");
    const operation = open[0];
    if (operation === undefined) return;

    if (operation.intent.kind === "run") {
      for (const entry of operation.intent.initialMessages) {
        if ((await session.getEntry(entry.id)) === undefined) {
          if (entry.type !== "message") {
            throw new Error("Cloud Agent Run recovery found a non-message initial entry");
          }
          await session.appendEntry(entry, lane);
        }
      }
      const tools = await session.findRecords({
        lane,
        type: "tool_started",
        runId: operation.id,
      });
      for (const tool of tools) {
        if ((await session.getEntry(tool.resultEntryId)) !== undefined) continue;
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          content: [{ type: "text", text: UNKNOWN_TOOL_EFFECT_TEXT }],
          details: { kind: "pi-cloud.unknown_tool_effect" },
          isError: true,
          timestamp: Date.now(),
        };
        await session.appendEntry({ id: tool.resultEntryId, type: "message", message }, lane);
      }
    }
    await tree.appendCustomEntry(INTERRUPTION_CUSTOM_TYPE, {
      content: recoveryMarker("Worker execution was interrupted before durable settlement"),
    });
    await session.appendRecord({
      id: this.#id(),
      lane,
      type: "operation_finished",
      runId: operation.id,
      outcome: "failed",
      error: { code: "interrupted", message: "Recovered an unfinished cloud Agent operation" },
    });
  }

  async #recordUsage(
    operationId: string,
    entryId: string,
    message: AgentMessage,
    assistantAttempt: number,
  ): Promise<void> {
    const record = this.#usageRecord(operationId, entryId, message, assistantAttempt);
    if (record !== undefined) await this.#options.session.appendRecord(record);
  }

  #usageRecord(
    operationId: string,
    entryId: string,
    message: AgentMessage,
    assistantAttempt: number,
  ): NewRecord<LaneRecord> | undefined {
    let usage: Usage | undefined;
    let cause: "assistant" | "tool";
    let toolCallId: string | undefined;
    if (message.role === "assistant") {
      usage = message.usage;
      cause = "assistant";
    } else if (message.role === "toolResult") {
      usage = message.usage;
      cause = "tool";
      toolCallId = message.toolCallId;
    } else {
      return undefined;
    }
    if (usage === undefined) return undefined;
    if (cause === "assistant") {
      const assistant = message as AssistantMessage;
      const stopReason = assistant.stopReason === "pending" ? "error" : assistant.stopReason;
      return {
        id: this.#id(),
        lane: this.#options.lane,
        type: "usage",
        cause,
        runId: operationId,
        entryId,
        attempt: Math.max(1, assistantAttempt),
        stopReason,
        usage,
      };
    }
    return {
      id: this.#id(),
      lane: this.#options.lane,
      type: "usage",
      cause,
      runId: operationId,
      entryId,
      toolCallId: toolCallId!,
      usage,
    };
  }
}
