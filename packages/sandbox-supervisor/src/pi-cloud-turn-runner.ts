import {
  createPiCloudEventFactory,
  MAX_TOOL_OUTPUT_BYTES,
  parseSupervisorToControlMessage,
  type PiCloudEvent,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
  type WorkspacePatch,
} from "@pi-cloud/protocol";
import {
  CloudAgentRuntime,
  PI_MODEL_RETRY_CUSTOM_TYPE,
  type CloudAgentExecutionAuthority,
  type CloudAgentRuntimeEvent,
} from "@pi-cloud/pi-session-postgres";
import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiAgentEventAdapter } from "./pi-agent-event-adapter.ts";
import {
  PI_WORLD_STATE_ENTRY_PROJECTORS,
  PiSessionWorldStateController,
  type PiSandboxContinuity,
} from "./pi-sandbox-continuity.ts";
import { PiSamplingStepController, type PiSamplingStepCapture } from "./pi-sampling-step.ts";
import {
  PiTurnCancelledError,
  PiTurnError,
  type PiCancellationSignal,
  type PiEventPublisher,
  type PiModelRuntimeConfig,
  type PiToolOutputArtifact,
  type PiToolOutputCapture,
  type PiTurnResult,
} from "./pi-turn-runtime.ts";
import type { TrustedRemoteAgentTools } from "./trusted-remote-tools-extension.ts";

type JsonRecord = Record<string, unknown>;

export type PiCloudSessionHandle = Readonly<{
  session: Session;
  authority: CloudAgentExecutionAuthority;
}>;

export type PiCloudTurnRunnerOptions = Readonly<{
  resolveModelRuntime: (
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ) => Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  openSession: (command: ExecuteTurnCommandMessage) => Promise<PiCloudSessionHandle>;
  createAgentTools: (context: {
    session: Session;
    toolOutputDirectory: string;
    stepWorldState: PiSessionWorldStateController;
    captureSamplingStep: (
      createFresh: () => Promise<Omit<PiSamplingStepCapture, "samplingAttempt">>,
      options?: Readonly<{ publishEvent?: boolean }>,
    ) => Promise<PiSamplingStepCapture>;
  }) => TrustedRemoteAgentTools;
  sandboxContinuity: PiSandboxContinuity;
  collectWorkspacePatch?: () => Promise<WorkspacePatch | undefined> | WorkspacePatch | undefined;
  onSettled?: (session: Session) => Promise<void> | void;
  persistToolOutputArtifact?: (output: PiToolOutputCapture) => Promise<PiToolOutputArtifact>;
  observeEvent?: (event: CloudAgentRuntimeEvent) => void;
  prepareFollowUp?: () => AgentMessage | undefined | Promise<AgentMessage | undefined>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
}>;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const MAXIMUM_PENDING_PUBLIC_EVENTS = 512;
const TEXT_DELTA_AGGREGATION_MS = 25;
const MAXIMUM_AGGREGATED_TEXT_CHARACTERS = 4_096;
const BASE_SYSTEM_PROMPT = [
  "You are a coding agent working in a remote, isolated project workspace.",
  "Use the provided read, write, edit, and bash tools to inspect and change the project.",
  "Do not claim that a command, test, or file change succeeded unless its Tool result confirms it.",
  "Use the user's language for every assistant-visible sentence, including progress narration before or between Tool calls and the final answer, unless the user explicitly requests another language.",
  "For browser applications, distinguish syntax/HTTP checks from real UI interaction tests; do not claim clicks or gameplay were verified without browser-equivalent evidence.",
  "When the user asks to run a Web application, bind it to 0.0.0.0 on any unprivileged port and leave the service running after validation. After the server is reachable, call the preview Tool with its verified port so PiCloud renders an authenticated Open application link. Report the listening port, but never tell the user to open localhost, 127.0.0.1, a private Sandbox IP, or a guessed public URL. Do not terminate the service unless the user asks you to stop it.",
  "Start every long-running server as a detached background process with stdin redirected from /dev/null and stdout/stderr redirected to a log file, then verify it in a separate bash Tool call. Do not leave a foreground server or inherited Tool output pipe open.",
  "Keep the final answer concise and report the files changed and verification performed.",
].join("\n");

function languageAlignmentInstruction(prompt: string): string | undefined {
  const hanCharacters = prompt.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu)?.length ?? 0;
  const latinCharacters = prompt.match(/[A-Za-z]/gu)?.length ?? 0;
  if (hanCharacters >= 4 && hanCharacters * 2 >= latinCharacters) {
    return "用户正在使用中文。所有对用户可见的内容，包括工具调用前后的进度说明和最终回答，都必须使用中文。";
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("Pi cloud clock must return a valid Date");
  }
  return value;
}

function validateRuntimeConfig(
  command: ExecuteTurnCommandMessage,
  config: PiModelRuntimeConfig,
): PiModelRuntimeConfig {
  if (
    config.provider !== command.payload.model.provider ||
    config.modelId !== command.payload.model.modelId
  ) {
    throw new PiTurnError(
      "model_binding_mismatch",
      "Resolved model runtime does not match the accepted turn",
      false,
    );
  }
  if (config.apiKey.length === 0) {
    throw new PiTurnError("credential_unavailable", "Model credential is unavailable", true);
  }
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiTurnError("invalid_model_runtime", "Model endpoint is invalid", false);
  }
  if (command.payload.model.thinkingLevel !== "off" && config.reasoning !== true) {
    throw new PiTurnError(
      "invalid_model_runtime",
      "The selected thinking level is unsupported",
      false,
    );
  }
  return config;
}

async function createModelRuntime(config: PiModelRuntimeConfig): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerProvider(config.provider, {
    name: config.provider,
    baseUrl: config.baseUrl,
    api: config.api,
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: config.reasoning ?? false,
        ...(config.provider === "deepseek" && config.reasoning === true
          ? {
              thinkingLevelMap: {
                minimal: "high" as const,
                low: "high" as const,
                medium: "high" as const,
                high: "high" as const,
                xhigh: "max" as const,
                max: "max" as const,
              },
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsStrictMode: false,
                maxTokensField: "max_tokens" as const,
                requiresReasoningContentOnAssistantMessages: true,
                thinkingFormat: "deepseek" as const,
              },
            }
          : {}),
        input: ["text"],
        contextWindow: config.contextWindow ?? 16_384,
        maxTokens: config.maxTokens ?? 1_024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey(config.provider, config.apiKey);
  return runtime;
}

function cancellationSignal(value: unknown): PiCancellationSignal {
  if (
    !isRecord(value) ||
    value.kind !== "pi-cloud.turn-cancellation" ||
    (value.reason !== "user_request" &&
      value.reason !== "timeout" &&
      value.reason !== "session_lease_revoked" &&
      value.reason !== "shutdown") ||
    !Number.isSafeInteger(value.gracePeriodMs) ||
    (value.gracePeriodMs as number) < 0
  ) {
    return { kind: "pi-cloud.turn-cancellation", reason: "shutdown", gracePeriodMs: 0 };
  }
  return value as PiCancellationSignal;
}

function streamedTextDelta(value: unknown): { delta: string; contentIndex?: number } | undefined {
  if (!isRecord(value) || value.type !== "message_update") return undefined;
  const streamEvent = value.assistantMessageEvent;
  if (
    !isRecord(streamEvent) ||
    streamEvent.type !== "text_delta" ||
    typeof streamEvent.delta !== "string"
  )
    return undefined;
  return {
    delta: streamEvent.delta,
    ...(Number.isSafeInteger(streamEvent.contentIndex)
      ? { contentIndex: streamEvent.contentIndex as number }
      : {}),
  };
}

function withStreamedTextDelta(
  value: CloudAgentRuntimeEvent,
  delta: string,
): CloudAgentRuntimeEvent {
  const source = value as unknown as JsonRecord;
  const streamEvent = source.assistantMessageEvent as JsonRecord;
  return {
    ...source,
    assistantMessageEvent: { ...streamEvent, delta },
  } as unknown as CloudAgentRuntimeEvent;
}

export class PiCloudTurnRunner {
  readonly #options: PiCloudTurnRunnerOptions;
  readonly #requestTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #clock: () => Date;
  readonly #id: () => string;
  #activeRuntime: CloudAgentRuntime | undefined;
  readonly #steerWaiters = new Set<{
    resolve(runtime: CloudAgentRuntime): void;
    reject(error: Error): void;
  }>();

  constructor(options: PiCloudTurnRunnerOptions) {
    this.#options = options;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#turnTimeoutMs = positiveInteger(
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "turnTimeoutMs",
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async steer(text: string): Promise<void> {
    const runtime =
      this.#activeRuntime ??
      (await new Promise<CloudAgentRuntime>((resolvePromise, rejectPromise) => {
        const waiter = { resolve: resolvePromise, reject: rejectPromise };
        this.#steerWaiters.add(waiter);
      }));
    runtime.steer(text);
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal?: AbortSignal,
  ): Promise<PiTurnResult> {
    if (command.payload.input.kind !== "prompt") {
      throw new PiTurnError(
        "unsupported_input",
        "Cloud Pi Runtime only supports prompt input",
        false,
      );
    }
    const config = validateRuntimeConfig(
      command,
      await this.#options.resolveModelRuntime(command.payload.model),
    );
    const modelRuntime = await createModelRuntime(config);
    const model = modelRuntime.getModel(config.provider, config.modelId);
    if (model === undefined)
      throw new PiTurnError("invalid_model_runtime", "Configured model is unavailable", false);
    const sessionHandle = await this.#options.openSession(command);
    let toolOutputDirectoryForCleanup: string | undefined;

    try {
      const toolOutputDirectory = await mkdtemp(resolve(tmpdir(), "pi-cloud-tool-output-"));
      toolOutputDirectoryForCleanup = toolOutputDirectory;
      const eventFactory = createPiCloudEventFactory(
        {
          sessionId: command.payload.sessionId,
          turnId: command.payload.turnId,
          agentId: command.payload.agentId,
        },
        {
          initialSequence: command.payload.nextEventSeq - 1,
          clock: this.#clock,
          idGenerator: this.#id,
        },
      );
      const adapter = new PiAgentEventAdapter(eventFactory, {
        inputKind: "prompt",
        requireSamplingIdentity: true,
        ...(command.payload.budgets === undefined
          ? {}
          : { maximumToolOutputBytes: command.payload.budgets.maximumToolOutputBytes }),
      });
      const worldState = await PiSessionWorldStateController.create(
        sessionHandle.session,
        this.#options.sandboxContinuity,
      );
      // Persist execution-world changes before the accepted user prompt is
      // appended so later context preserves the causal boundary.
      await worldState.capture();
      const samplingSteps = new PiSamplingStepController();
      let toolStarted = false;
      let eventChain = Promise.resolve();
      let pendingPublicEvents = 0;
      let fatalError: Error | undefined;

      const eventMessage = (event: PiCloudEvent): EventPublishMessage => {
        const parsed = parseSupervisorToControlMessage({
          protocolVersion: 1,
          messageId: this.#id(),
          sentAt: validDate(this.#clock).toISOString(),
          type: "event.publish",
          payload: {
            executionLease: command.payload.executionLease,
            event,
          },
        });
        if (parsed.type !== "event.publish")
          throw new PiTurnError("pi_protocol_error", "Pi event envelope was invalid", false);
        return parsed;
      };

      const publishMapped = async (
        source: unknown,
      ): Promise<ReturnType<PiAgentEventAdapter["adapt"]>> => {
        const outcome = adapter.adapt(source);
        if (outcome.kind === "invalid")
          throw new PiTurnError("pi_protocol_error", outcome.reason, false);
        if (outcome.kind === "mapped" && outcome.event.type === "model.sampling.retry.scheduled") {
          await sessionHandle.session.appendCustomEntry(PI_MODEL_RETRY_CUSTOM_TYPE, {
            nextSamplingAttempt: outcome.event.payload.nextSamplingAttempt,
            maximumSamplingAttempts: outcome.event.payload.maximumSamplingAttempts,
            delayMs: outcome.event.payload.delayMs,
          });
        }
        if (outcome.kind === "mapped" && isRecord(source) && source.type === "auto_retry_start") {
          samplingSteps.scheduleRetry(source.attempt as number);
        } else if (
          isRecord(source) &&
          source.type === "auto_retry_end" &&
          source.success === false
        ) {
          samplingSteps.cancelScheduledRetry();
        }
        if (outcome.kind === "mapped") {
          let publicEvent = outcome.event;
          if (publicEvent.type === "tool.started") toolStarted = true;
          if (
            publicEvent.type === "tool.completed" &&
            this.#options.persistToolOutputArtifact !== undefined
          ) {
            const artifactPath = resolve(
              toolOutputDirectory,
              `${createHash("sha256").update(publicEvent.payload.toolCallId, "utf8").digest("hex")}.output`,
            );
            const metadata = await lstat(artifactPath).catch((error: unknown) =>
              isRecord(error) && error.code === "ENOENT" ? undefined : Promise.reject(error),
            );
            if (metadata !== undefined) {
              if (
                !metadata.isFile() ||
                metadata.isSymbolicLink() ||
                metadata.size > MAX_TOOL_OUTPUT_BYTES
              ) {
                throw new PiTurnError(
                  "tool_output_artifact_invalid",
                  "Trusted Tool output artifact was invalid",
                  false,
                );
              }
              const artifact = await this.#options.persistToolOutputArtifact({
                toolCallId: publicEvent.payload.toolCallId,
                bytes: await readFile(artifactPath),
              });
              publicEvent = {
                ...publicEvent,
                payload: { ...publicEvent.payload, outputArtifact: artifact },
              };
            }
          }
          await publishEvent(eventMessage(publicEvent));
        }
        return outcome;
      };

      const enqueue = (event: CloudAgentRuntimeEvent): void => {
        pendingPublicEvents += 1;
        eventChain = eventChain
          .then(async () => {
            await publishMapped(this.#adapterEvent(event));
          })
          .catch((error: unknown) => {
            fatalError ??= error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            pendingPublicEvents -= 1;
          });
      };
      let textBlockActive = false;
      let pendingText:
        { event: CloudAgentRuntimeEvent; delta: string; contentIndex?: number } | undefined;
      let textFlushTimer: NodeJS.Timeout | undefined;
      const flushPendingText = (): void => {
        if (textFlushTimer !== undefined) clearTimeout(textFlushTimer);
        textFlushTimer = undefined;
        if (pendingText === undefined) return;
        const buffered = pendingText;
        pendingText = undefined;
        enqueue(withStreamedTextDelta(buffered.event, buffered.delta));
      };
      const scheduleTextFlush = (): void => {
        if (textFlushTimer !== undefined) return;
        textFlushTimer = setTimeout(flushPendingText, TEXT_DELTA_AGGREGATION_MS);
        textFlushTimer.unref();
      };
      const bufferText = (
        event: CloudAgentRuntimeEvent,
        delta: { delta: string; contentIndex?: number },
      ): void => {
        if (!textBlockActive) {
          textBlockActive = true;
          enqueue(event);
          return;
        }
        if (
          pendingText !== undefined &&
          pendingText.contentIndex === delta.contentIndex &&
          pendingText.delta.length + delta.delta.length <= MAXIMUM_AGGREGATED_TEXT_CHARACTERS
        ) {
          pendingText.delta += delta.delta;
        } else {
          flushPendingText();
          pendingText = {
            event,
            delta: delta.delta,
            ...(delta.contentIndex === undefined ? {} : { contentIndex: delta.contentIndex }),
          };
        }
        if (pendingText.delta.length >= MAXIMUM_AGGREGATED_TEXT_CHARACTERS) flushPendingText();
        else scheduleTextFlush();
      };
      const tools = this.#options.createAgentTools({
        session: sessionHandle.session,
        toolOutputDirectory,
        stepWorldState: worldState,
        captureSamplingStep: async (createFresh, captureOptions) => {
          const captured = await samplingSteps.captureAsync(createFresh);
          if (captureOptions?.publishEvent !== false) {
            eventChain = eventChain.then(() =>
              publishEvent(
                eventMessage(
                  adapter.samplingStarted({
                    stepSequence: captured.step.context.sequence,
                    stepSha256: captured.step.sha256,
                    samplingAttempt: captured.samplingAttempt,
                  }),
                ),
              ),
            );
            await eventChain;
            if (fatalError !== undefined) throw fatalError;
          }
          return captured;
        },
      });
      const runtime = new CloudAgentRuntime({
        session: sessionHandle.session,
        authority: sessionHandle.authority,
        model,
        models: modelRuntime,
        systemPrompt: () => {
          const alignment =
            command.payload.input.kind === "prompt"
              ? languageAlignmentInstruction(command.payload.input.text)
              : undefined;
          const platformPrompt =
            alignment === undefined ? BASE_SYSTEM_PROMPT : `${alignment}\n${BASE_SYSTEM_PROMPT}`;
          return tools.systemPrompt(
            command.payload.agentSystemPrompt === undefined
              ? platformPrompt
              : `${platformPrompt}\n\n${command.payload.agentSystemPrompt}`,
          );
        },
        tools: tools.tools,
        thinkingLevel: command.payload.model.thinkingLevel,
        streamOptions: {
          timeoutMs: this.#requestTimeoutMs,
          // The cloud runtime owns visible, governed retry attempts so each one
          // receives a fresh sampling identity and model-request ledger row.
          maxRetries: 0,
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
        compaction: {
          enabled: true,
          reserveTokens: command.payload.budgets?.compactionReserveTokens ?? 16_384,
          keepRecentTokens: command.payload.budgets?.compactionKeepRecentTokens ?? 20_000,
        },
        transformContext: (messages) => tools.transformContext(messages),
        prepareContextMaintenance: async (messages) => {
          await tools.transformContext(messages, "context_maintenance");
        },
        transformHeaders: (headers) =>
          tools.transformHeaders(headers as ProviderHeaders) as Promise<
            Record<string, string | null>
          >,
        entryProjectors: PI_WORLD_STATE_ENTRY_PROJECTORS,
        compactionRetainedCustomTypes: Object.keys(PI_WORLD_STATE_ENTRY_PROJECTORS),
        onEvent: async (event) => {
          this.#options.observeEvent?.(event);
          const textDelta = streamedTextDelta(event);
          if (textDelta === undefined) {
            flushPendingText();
            textBlockActive = false;
            enqueue(event);
            await eventChain;
          } else {
            bufferText(event, textDelta);
            if (pendingPublicEvents >= MAXIMUM_PENDING_PUBLIC_EVENTS) {
              flushPendingText();
              await eventChain;
            }
          }
          if (fatalError !== undefined) throw fatalError;
        },
        ...(this.#options.prepareFollowUp === undefined
          ? {}
          : { prepareFollowUp: this.#options.prepareFollowUp }),
        idGenerator: this.#id,
      });
      this.#activeRuntime = runtime;
      for (const waiter of this.#steerWaiters) waiter.resolve(runtime);
      this.#steerWaiters.clear();

      const timeout = new AbortController();
      const timer = setTimeout(
        () =>
          timeout.abort({
            kind: "pi-cloud.turn-cancellation",
            reason: "timeout",
            gracePeriodMs: 0,
          }),
        this.#turnTimeoutMs,
      );
      timer.unref();
      const combined =
        signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
      const abort = (): void => {
        const cancellation = cancellationSignal(combined.reason);
        try {
          adapter.requestCancellation(cancellation.reason);
        } catch {
          /* already settled */
        }
        runtime.abort();
      };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();

      try {
        const result = await runtime.run(command.payload.input.text);
        flushPendingText();
        await eventChain;
        if (fatalError !== undefined) throw fatalError;
        if (result.kind === "completed") {
          await sessionHandle.authority.assertCurrent();
          await this.#options.onSettled?.(sessionHandle.session);
          await sessionHandle.authority.assertCurrent();
        } else {
          if (toolStarted) await worldState.recordUnavailable().catch(() => undefined);
        }
        const settled = await publishMapped({ type: "agent_settled" });
        if (settled.kind !== "settled")
          throw new PiTurnError("pi_protocol_error", "Pi did not settle", false);
        if (settled.result.status === "cancelled")
          throw new PiTurnCancelledError(settled.result.reason, settled.result.forced);
        if (settled.result.status === "failed")
          throw new PiTurnError(
            settled.result.code,
            settled.result.message,
            settled.result.retryable,
          );
        const workspacePatch = await this.#options.collectWorkspacePatch?.();
        return {
          stopReason: settled.result.stopReason,
          ...(workspacePatch === undefined ? {} : { workspacePatch }),
        };
      } catch (error: unknown) {
        if (toolStarted) await worldState.recordUnavailable().catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        flushPendingText();
        await eventChain.catch(() => undefined);
        this.#activeRuntime = undefined;
        for (const waiter of this.#steerWaiters)
          waiter.reject(
            new PiTurnError(
              "steer_target_unavailable",
              "Pi Run ended before steer delivery",
              false,
            ),
          );
        this.#steerWaiters.clear();
      }
    } finally {
      await sessionHandle.authority.close();
      if (toolOutputDirectoryForCleanup !== undefined) {
        await rm(toolOutputDirectoryForCleanup, { recursive: true, force: true });
      }
    }
  }

  #adapterEvent(event: CloudAgentRuntimeEvent): unknown {
    if (event.type === "compaction_start") return event;
    if (event.type === "compaction_end") {
      return {
        type: "compaction_end",
        reason: event.reason,
        aborted: !event.success,
        willRetry: false,
        ...(event.result === undefined ? {} : { result: event.result }),
      };
    }
    return event;
  }
}
