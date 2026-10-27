import { MODEL_EVENT_IDLE_MS, MODEL_RETRY_COUNT } from "./durable/model-wait-policy.ts";
import { DurableTextPresentation } from "./durable/text-presentation.ts";
import {
  prepareNativeSettlementFollowUp,
  type PiSettlementGatePolicy,
} from "./pi-settlement-gate.ts";
import { fixedRemoteToolDefinitions } from "./fixed-remote-tool-definitions.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketDebugStats,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  awaitWithContext,
} from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  UserInput,
  AgentEventStream,
  TaskId,
} from "@earendil-works/pi-durable";
import type { Context as ModelContext, ImageContent, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  createPiCloudEventFactory,
  hasConversationWorkspace,
  resolveAgentProfile,
  inputWithUploads,
  assertUserInputBudget,
  parseUserUploads,
  assertPreparedUserInputBudget,
  MAX_INPUT_IMAGE_HINT_BYTES,
  type ExecuteTurnCommandMessage,
  type PiCloudEventBody,
  type ModelSamplingIdentity,
  type UserUpload,
  type RunActivityUpdate,
  type RunInterruptionReason,
  ToolResultAttachmentError,
} from "@pi-cloud/protocol";
import type { DurableSessionHandle } from "@pi-cloud/pi-session-postgres/durable";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { DurableAgentSession, type DurableRunConfiguration } from "./durable/agent-session.ts";
import { DurableRunEvents } from "./durable/run-events.ts";
import { CloudModelRegistry } from "./durable/model-registry.ts";
import {
  PiSessionWorldStateController,
  type PiSandboxContinuity,
} from "./pi-sandbox-continuity.ts";
import { DurableSampling, type PiSamplingStepCapture } from "./durable/sampling.ts";
import { withToolInvocation } from "./tool-invocation.ts";
import { prepareToolPresentation } from "./durable/tool-presentation.ts";
import { PiRunActivity } from "./pi-run-activity.ts";
import {
  PiTurnError,
  PiTurnCancelledError,
  type PiModelRuntimeConfig,
  type PiTurnResult,
  type PiEventPublisher,
  type PiCancellationSignal,
} from "./pi-turn-runtime.ts";
import type { TrustedRemoteAgentTools } from "./trusted-remote-tools.ts";
import { mergeProviderHostedTools, mergeProviderServiceTier } from "./provider-hosted-tools.ts";
import {
  nativeProviderContext,
  replayProviderHostedTranscripts,
} from "./provider-hosted-transcript.ts";
import type { ProviderHostedActivity } from "./agent-turn-runtime.ts";

export type PiCloudSessionHandle = DurableSessionHandle;
export type PiCloudTurnRunnerOptions = {
  publicEgress?: () => import("@pi-cloud/protocol").GuestPublicEgress;
  prepareInputUploads?: (
    uploads: readonly UserUpload[],
    signal?: AbortSignal,
  ) => Promise<{ images: ImageContent[]; hints: string[] }>;
  resolveModelRuntime(
    model: ExecuteTurnCommandMessage["payload"]["model"],
  ): Promise<PiModelRuntimeConfig> | PiModelRuntimeConfig;
  openSession(
    command: ExecuteTurnCommandMessage,
    signal?: AbortSignal,
  ): Promise<PiCloudSessionHandle>;
  modelRegistry?: CloudModelRegistry;
  trustedToolDefinitions?: {
    current(): readonly import("@earendil-works/pi-durable").ToolRegistration[];
    subscribe(listener: () => void): () => void;
  };
  acquireModelPermit?: (signal?: AbortSignal) => Promise<() => void>;
  interruptionReason?: () => RunInterruptionReason | undefined;
  onToolResultUnavailable?: (error: ToolResultAttachmentError) => void;
  metrics?: PiCloudMetrics;
  createAgentTools(context: {
    stepWorldState: PiSessionWorldStateController;
    captureSamplingStep(
      createFresh: (sequence: number) => Promise<Omit<PiSamplingStepCapture, "samplingAttempt">>,
      options?: { publishEvent?: boolean },
    ): Promise<PiSamplingStepCapture>;
  }): TrustedRemoteAgentTools;
  sandboxContinuity: PiSandboxContinuity;
  onSettled?: () => Promise<void> | void;
  onNativeBound?: () => Promise<void>;
  beforeEffect?: (signal?: AbortSignal) => Promise<void>;
  onActivity?: (update: RunActivityUpdate | undefined) => void;
  settlementPolicy?: PiSettlementGatePolicy;
  modelEventIdleTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

const BASE_SYSTEM_PROMPT = [
  "Do not claim that a command, test, or file change succeeded unless its Tool result confirms it.",
  "Use the user's language for every assistant-visible sentence, including progress narration before or between Tool calls and the final answer, unless the user explicitly requests another language.",
  "Keep the final answer concise and report the files changed and verification performed.",
].join("\n");

const WORKSPACE_SYSTEM_PROMPT = [
  "You are a coding agent working in a remote, isolated project workspace.",
  "Use only the offered workspace tools to inspect and change the project.",
  "For browser applications, distinguish syntax/HTTP checks from real UI interaction tests; do not claim clicks or gameplay were verified without browser-equivalent evidence.",
  "The standard Tool Sandbox includes a version-matched Chromium and Playwright stack with CJK fonts. In a Bash Node.js module script, import { chromium, devices } from '/opt/pi-cloud/browser/index.mjs'. Launch headlessly when browser verification is needed, interact with the running local application, inspect console/request failures, and close the browser in finally. Save screenshots in the Workspace and use read to inspect them. Keep project dependencies separate from this platform package and verify actual browser outcomes before claiming success.",
  "When the user asks to run a Web application, bind it to 0.0.0.0 on any unprivileged port and leave the service running after validation. After the server is reachable, if the preview Tool is available, call it with its verified port and include the returned application path as a Markdown link in your answer. Use the application name as the link label; omit an internal port label unless requested. Never tell the user to open localhost, 127.0.0.1, a private Sandbox IP, or a guessed public URL. Do not terminate the service unless the user asks you to stop it.",
  "Start services intended to outlive the Bash Tool in the background, redirect stdin from /dev/null and stdout/stderr to a log file, and verify readiness before presenting a preview.",
].join("\n");

function languageAlignmentInstruction(prompt: string): string | undefined {
  const hanCharacters = prompt.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu)?.length ?? 0;
  const latinCharacters = prompt.match(/[A-Za-z]/gu)?.length ?? 0;
  if (hanCharacters >= 4 && hanCharacters * 2 >= latinCharacters) {
    return "用户正在使用中文。所有对用户可见的内容，包括工具调用前后的进度说明和最终回答，都必须使用中文。";
  }
  return undefined;
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
  if ((config.serviceTier ?? null) !== command.payload.model.serviceTier) {
    throw new PiTurnError(
      "model_binding_mismatch",
      "Resolved model runtime service tier does not match the accepted turn",
      false,
    );
  }
  if (config.serviceTier === "fast" && config.provider !== "openai-codex") {
    throw new PiTurnError("invalid_model_runtime", "Fast mode requires an OpenAI model", false);
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
  if (
    (config.hostedTools?.length ?? 0) > 0 &&
    config.api !== "openai-responses" &&
    config.api !== "openai-codex-responses"
  ) {
    throw new PiTurnError(
      "invalid_model_runtime",
      "Provider-hosted Tools require a Responses model runtime",
      false,
    );
  }
  return config;
}

const sharedModels = new CloudModelRegistry();
function cancellationReason(signal: AbortSignal): PiCancellationSignal["reason"] {
  const reason = signal.reason as Partial<PiCancellationSignal> | undefined;
  return reason?.reason === "user_request" ||
    reason?.reason === "timeout" ||
    reason?.reason === "session_lease_revoked"
    ? reason.reason
    : "shutdown";
}

/** One admitted logical Run on the family's native Harness. Pi owns execution,
 * submission placement, abort, retry and checkpoints; this class supplies ports. */
export class PiCloudTurnRunner {
  readonly #options: PiCloudTurnRunnerOptions;
  readonly #ready = Promise.withResolvers<Conversation>();
  #ended = false;
  #inputVersion = 0;
  #inputLine: Promise<unknown> = Promise.resolve();
  #humanInputs: DurableHumanInputs | undefined;
  #compact: ((command: NativeCompactCommand) => Promise<NativeCompactResult>) | undefined;
  #identity: { tenantId: string; sessionId: string; runId: string } | undefined;
  constructor(options: PiCloudTurnRunnerOptions) {
    this.#options = options;
    void this.#ready.promise.catch(() => undefined);
  }
  async waitUntilReady(): Promise<void> {
    await this.#ready.promise;
  }
  async compact(command: NativeCompactCommand): Promise<NativeCompactResult> {
    await this.#ready.promise;
    if (
      !this.#identity ||
      command.tenantId !== this.#identity.tenantId ||
      command.sessionId !== this.#identity.sessionId ||
      command.runId !== this.#identity.runId
    )
      throw new PiTurnError("input_target_unavailable", "Compact target changed", false);
    return this.#onInputLine(async () => {
      if (this.#ended || !this.#compact)
        throw new PiTurnError("input_target_unavailable", "Compact target is closing", true);
      const result = await this.#compact(command);
      this.#inputVersion++;
      return result;
    });
  }
  #onInputLine<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#inputLine.then(action);
    this.#inputLine = next.catch(() => undefined);
    return next;
  }
  async #prepareInput(
    text: string,
    uploads: readonly UserUpload[] = [],
    signal?: AbortSignal,
  ): Promise<UserInput> {
    assertUserInputBudget(text, uploads);
    const described = inputWithUploads(text, uploads);
    if (!uploads.some((file) => file.image)) return described;
    if (!this.#options.prepareInputUploads)
      throw new PiTurnError(
        "input_images_unavailable",
        "Input image preparation is unavailable",
        false,
      );
    const prepared = await this.#options.prepareInputUploads(uploads, signal);
    const hints = prepared.hints.length ? `\nImage preparation: ${prepared.hints.join(" ")}` : "";
    if (
      Buffer.byteLength(JSON.stringify(hints)) - 2 >
      prepared.images.length * MAX_INPUT_IMAGE_HINT_BYTES
    )
      throw new PiTurnError(
        "input_image_hints_invalid",
        "Image preparation exceeded its metadata budget",
        false,
      );
    assertPreparedUserInputBudget(described + hints, prepared.images.length);
    return [{ type: "text", text: described + hints }, ...prepared.images];
  }
  async humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
    await this.#ready.promise;
    if (
      !this.#identity ||
      command.tenantId !== this.#identity.tenantId ||
      command.sessionId !== this.#identity.sessionId ||
      command.runId !== this.#identity.runId
    )
      throw new PiTurnError("input_target_unavailable", "Input target changed", false);
    return this.#onInputLine(async () => {
      if (!this.#humanInputs)
        throw new PiTurnError("input_target_unavailable", "Input runtime is unavailable", true);
      const result =
        command.action === "submit"
          ? await this.#humanInputs.submit(command.input)
          : await this.#humanInputs.mutate(command.mutation);
      this.#inputVersion++;
      return result;
    });
  }
  async agentInput(
    id: string,
    text: string,
    delivery: "notify" | "steer" | "follow_up",
    uploads?: readonly UserUpload[],
  ): Promise<void> {
    const conversation = await this.#ready.promise;
    await this.#onInputLine(async () => {
      if (this.#ended)
        throw new PiTurnError(
          "steer_target_unavailable",
          "Pi Run has closed input delivery",
          false,
        );
      const content = await this.#prepareInput(text, uploads);
      await conversation.submit(
        {
          type: "input",
          content,
          requestId: id,
          whenBusy: delivery === "follow_up" ? "followUp" : "steer",
        },
        BACKGROUND_CONTEXT,
      );
      this.#inputVersion++;
    });
  }
  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal?: AbortSignal,
  ): Promise<PiTurnResult> {
    const options = this.#options,
      p = command.payload;
    this.#identity = { tenantId: p.tenantId, sessionId: p.sessionId, runId: p.runId };
    if (p.input.kind === "resume" && (!p.conversationWork || p.piSession.conversationId === 1))
      throw new PiTurnError(
        "unsupported_input",
        "Native resume requires an existing child Conversation",
        false,
      );
    const clock = options.clock ?? (() => new Date()),
      id = options.idGenerator ?? (() => crypto.randomUUID());
    const activity = new PiRunActivity(options.onActivity);
    activity.phase("preparing");
    // Work follows native settlement and execution ownership, not elapsed time.
    const combined = signal ?? new AbortController().signal;
    let handle: DurableSessionHandle | undefined,
      family: DurableAgentSession | undefined,
      stream: AgentEventStream | undefined,
      text: DurableTextPresentation | undefined;
    let toolSampling: ModelSamplingIdentity | undefined;
    const cleanup: (() => void)[] = [];
    const modelSocketScopes = new Set<string>();
    cleanup.push(() => {
      for (const key of modelSocketScopes) {
        closeOpenAICodexWebSocketSessions(key);
        resetOpenAICodexWebSocketDebugStats(key);
      }
      modelSocketScopes.clear();
    });
    // User Stop still needs native reads to withdraw queued input and settle
    // aborts. Worker retirement, unlike Stop, cancels this owner's startup I/O.
    const readLifetime = new AbortController();
    const retireReads = () => {
      if (!["user_request", "timeout"].includes(cancellationReason(combined)))
        readLifetime.abort(
          new PiTurnError("worker_shutdown", "The native owner is stopping", true),
        );
    };
    combined.addEventListener("abort", retireReads, { once: true });
    cleanup.push(() => combined.removeEventListener("abort", retireReads));
    if (combined.aborted) retireReads();
    let delivery = Promise.resolve(),
      deliveryFailure: unknown;
    let factory = createPiCloudEventFactory(
      { sessionId: p.sessionId, turnId: p.turnId, agentId: p.agentId },
      { initialSequence: p.nextEventSeq - 1, clock, idGenerator: id },
    );
    const frameBodies = new AsyncLocalStorage<PiCloudEventBody[]>();
    const emit = (body: PiCloudEventBody, nativeSequence?: number): Promise<void> => {
      const collecting = frameBodies.getStore();
      if (collecting) {
        collecting.push(body);
        return Promise.resolve();
      }
      const publish = async () => {
        const candidate = createPiCloudEventFactory(
          { sessionId: p.sessionId, turnId: p.turnId, agentId: p.agentId },
          { initialSequence: factory.currentSequence(), clock, idGenerator: id },
        );
        const event = candidate.next(body);
        try {
          await publishEvent({
            protocolVersion: 1,
            messageId: id(),
            sentAt: validDate(clock).toISOString(),
            type: "event.publish",
            payload: {
              executionReference: p.executionReference,
              event,
              ...(nativeSequence === undefined ||
              (!text?.canCover(nativeSequence) &&
                !(
                  p.conversationWork &&
                  ["turn.completed", "turn.failed", "turn.cancelled"].includes(body.type)
                ))
                ? {}
                : { nativeSequence }),
            },
          });
        } catch (cause) {
          handle?.interrupt(
            Object.assign(new Error("Session display publication failed", { cause }), {
              code: "writer_publication_failed",
            }),
          );
          throw cause;
        }
        factory = candidate;
      };
      delivery = handle ? handle.serializePublication(publish) : delivery.then(publish);
      void delivery.catch((error) => {
        deliveryFailure ??= error;
      });
      return delivery;
    };
    try {
      const config = validateRuntimeConfig(command, await options.resolveModelRuntime(p.model));
      handle = await options.openSession(command, readLifetime.signal);
      const owner = handle;
      text = new DurableTextPresentation({
        conversationId: p.piSession.conversationId,
      });
      owner.prepareDisplay((commit, documents) => {
        const candidate = createPiCloudEventFactory(
          { sessionId: p.sessionId, turnId: p.turnId, agentId: p.agentId },
          { initialSequence: factory.currentSequence(), clock, idGenerator: id },
        );
        const toolEvents = prepareToolPresentation(commit, documents, candidate, {
          conversationId: p.piSession.conversationId,
          maximumOutputBytes: p.budgets?.maximumToolOutputBytes ?? 65536,
          ...(toolSampling ? { sampling: toolSampling } : {}),
        });
        const prepared = text!.prepare(commit, documents, candidate);
        return {
          events: [...toolEvents, ...prepared.events],
          ...(prepared.coveredThrough === undefined
            ? {}
            : { coveredThrough: prepared.coveredThrough }),
          confirmed: () => {
            prepared.confirmed();
            factory = candidate;
          },
        };
      });
      const registry = options.modelRegistry ?? sharedModels;
      const model = registry.configure(config);
      // Schemas are code-owned; constructing them does not access a guest.
      family = await owner.runtime(async () => {
        const runtime = await DurableAgentSession.open(
          owner.storage,
          {
            models: registry.models,
            remoteTools: [
              ...fixedRemoteToolDefinitions(),
              ...(options.trustedToolDefinitions?.current() ?? []).filter(
                (tool) => "prepareExecution" in tool,
              ),
            ],
            infrastructureTools: options.trustedToolDefinitions?.current() ?? [],
            ...(options.trustedToolDefinitions
              ? {
                  remoteToolUpdates: {
                    current: () => [
                      ...fixedRemoteToolDefinitions(),
                      ...options
                        .trustedToolDefinitions!.current()
                        .filter((tool) => "prepareExecution" in tool),
                    ],
                    subscribe: options.trustedToolDefinitions.subscribe,
                  },
                }
              : {}),
            ...(options.publicEgress ? { publicEgress: options.publicEgress } : {}),
            settings: {
              stream: {
                timeoutMs: 0,
                maxRetries: 0,
                ...(config.transport ? { transport: config.transport } : {}),
              },
              retry: { maxRetries: MODEL_RETRY_COUNT },
              compaction: {
                reserveTokens: p.budgets?.compactionReserveTokens ?? 16384,
                keepRecentTokens: p.budgets?.compactionKeepRecentTokens ?? 20000,
              },
            },
          },
          withAbortSignal(
            AbortSignal.any([readLifetime.signal, owner.authority.signal]),
            BACKGROUND_CONTEXT,
          ),
        );
        owner.preparePublication((commit) => runtime.preparePublication(commit));
        return runtime;
      });
      const runtime = family;
      // root() writes only the native root; it does not enable scheduling.
      if (p.piSession.conversationId === 1) await runtime.harness.root(BACKGROUND_CONTEXT);
      const world = await PiSessionWorldStateController.create(
        runtime.harness,
        p.piSession.conversationId as ConversationId,
        options.sandboxContinuity,
      );
      await world.capture();
      let sampling = new DurableSampling();
      const samplingScope = new AsyncLocalStorage<{
        sampling: DurableSampling;
        identity: ModelSamplingIdentity | undefined;
      }>();
      let observedEntry = 0,
        wakeObserved: (() => void) | undefined;
      const humanEntries = new Map<number, string>();
      cleanup.push(
        runtime.harness.subscribeCommits((publication) => {
          for (const change of publication.changes)
            if (
              change.type === "submission" &&
              change.value.conversationId === p.piSession.conversationId &&
              change.value.requestId?.startsWith("input-") &&
              "entry" in change.value &&
              change.value.entry !== undefined
            )
              humanEntries.set(change.value.entry, change.value.requestId);
        }),
      );
      const events = new DurableRunEvents({
        emit,
        humanInput: async (entryId) => {
          const inputId = humanEntries.get(entryId);
          if (!inputId) return;
          const metadata = await runtime.harness.snapshot(
            HumanInputDocument,
            p.piSession.conversationId as ConversationId,
            p.runId,
            BACKGROUND_CONTEXT,
          );
          const input = metadata?.inputs[inputId];
          return input
            ? { inputId, text: input.text, uploads: parseUserUploads(input.uploads) }
            : undefined;
        },
        retryAttempts: MODEL_RETRY_COUNT + 1,
        task: (taskId) => runtime.harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT),
      });
      const tools = options.createAgentTools({
        stepWorldState: world,
        captureSamplingStep: async (fresh, capture) => {
          const scope = samplingScope.getStore();
          const current = scope?.sampling ?? sampling;
          const step = await current.capture(fresh);
          const identity = {
            stepSequence: step.step.context.sequence,
            stepSha256: step.step.sha256,
            samplingAttempt: step.samplingAttempt,
          };
          if (scope) scope.identity = identity;
          if (!scope || current.publish) toolSampling = identity;
          if (capture?.publishEvent !== false && current.publish) {
            await events.samplingStarted(identity);
          }
          return step;
        },
      });
      const onHostedActivity = (value: ProviderHostedActivity) => {
        void emit({
          type:
            value.phase === "started"
              ? "provider.hosted_tool.started"
              : "provider.hosted_tool.completed",
          payload: {
            toolName: value.toolName,
            activityId: value.activityId,
            ...(value.phase === "completed"
              ? { outcome: value.outcome, ...(value.action ? { action: value.action } : {}) }
              : {}),
          },
        } as PiCloudEventBody).catch(() => undefined);
      };
      const prompt = [
        p.input.kind === "prompt" ? languageAlignmentInstruction(p.input.text) : undefined,
        BASE_SYSTEM_PROMPT,
        hasConversationWorkspace(p)
          ? WORKSPACE_SYSTEM_PROMPT
          : "You are a PiCloud Agent without Linux workspace access.",
        p.agentSystemPrompt,
      ]
        .filter(Boolean)
        .join("\n\n");
      const binding: DurableRunConfiguration = {
        runId: p.runId,
        conversationId: p.piSession.conversationId,
        model,
        ...(config.autoCompactTokenLimit === undefined
          ? {}
          : { autoCompactTokenLimit: config.autoCompactTokenLimit }),
        context: {
          sessionId: p.sessionId,
          turnId: p.turnId,
          selectedThinkingLevel: p.model.thinkingLevel,
          ...(p.conversationWork ? { view: JSON.parse(JSON.stringify(p.conversationWork)) } : {}),
        },
        agent:
          p.input.kind === "resume" || p.input.kind === "compact"
            ? {}
            : {
                instructions: await tools.systemPrompt(prompt),
                cwd: p.workingDirectory,
                thinkingLevel: resolveAgentProfile(p.model.thinkingLevel).thinkingLevel,
              },
        remoteTools: () =>
          tools.tools.filter((tool) => tool.prepareExecution).map((tool) => tool.name),
        tools: tools.tools.filter((tool) => !tool.prepareExecution),
        assertCurrent: () => owner.authority.assertCurrent(),
        ...(p.stopOnResume || options.beforeEffect
          ? {
              beforeEffect: async (effectSignal?: AbortSignal) => {
                await options.beforeEffect?.(effectSignal);
                if (!p.stopOnResume) return;
                await awaitWithContext(
                  new Promise<void>(() => {}),
                  withAbortSignal(
                    AbortSignal.any([
                      combined,
                      owner.authority.signal,
                      ...(effectSignal ? [effectSignal] : []),
                    ]),
                    BACKGROUND_CONTEXT,
                  ),
                );
              },
            }
          : {}),
        prepareRemote: async (invocation) => {
          if (!sampling.selected) {
            const task = await owner.storage.task(invocation.taskId as TaskId, BACKGROUND_CONTEXT);
            const sequence = await owner.recordSequence(task?.owner ?? invocation.taskId);
            if (sequence === undefined)
              throw new Error("Tool has no committed native request boundary");
            sampling.select({ sequence, attempt: 1, publish: false });
          }
          const tool = tools.tools.find((tool) => tool.name === invocation.toolName);
          const prepare = invocation.recovery ? tool?.prepareRecovery : tool?.prepareExecution;
          if (!tool || !prepare) throw new Error("Remote Tool has no matching preparation port");
          const prepared = await withToolInvocation(
            {
              id: `task:${invocation.taskId}`,
              nativeToolCallId: invocation.callId,
            },
            () =>
              prepare.call(
                tool,
                invocation.callId,
                invocation.args,
                invocation.context.abortSignal,
              ),
          );
          return {
            ...prepared,
            result: async () => {
              try {
                return await prepared.result();
              } catch (error) {
                if (error instanceof ToolResultAttachmentError) {
                  combined.throwIfAborted();
                  owner.authority.signal.throwIfAborted();
                  invocation.context.abortSignal?.throwIfAborted();
                  options.onToolResultUnavailable?.(error);
                }
                throw error;
              }
            },
          };
        },
        openModel: async (request, native) => {
          await owner.authority.assertCurrent();
          const requestSignal = AbortSignal.any([
            combined,
            owner.authority.signal,
            ...(request.options.signal ? [request.options.signal] : []),
          ]);
          requestSignal.throwIfAborted();
          const release = (await options.acquireModelPermit?.(requestSignal)) ?? (() => {});
          try {
            if (!native) throw new Error("Model request has no native task context");
            const task = await runtime.harness.getTask(native.taskId as TaskId, BACKGROUND_CONTEXT);
            const sequence = await owner.recordSequence(native.taskId);
            const checkpoint =
              task?.state.status === "pending" ||
              task?.state.status === "running" ||
              task?.state.status === "waiting"
                ? (task.state.checkpoint as { attempt?: number })
                : undefined;
            if (sequence === undefined || !checkpoint)
              throw new Error("Model task has no committed checkpoint");
            const scoped = {
              sampling: new DurableSampling(),
              identity: undefined as ModelSamplingIdentity | undefined,
            };
            scoped.sampling.select({
              sequence,
              attempt: checkpoint.attempt ?? 1,
              publish: native.purpose === "agent",
            });
            if (native.purpose === "agent") sampling = scoped.sampling;
            return await samplingScope.run(scoped, async () => {
              const source = request.input as ModelContext;
              const prepared = await tools.prepareModelRequest(
                source.messages,
                native.purpose,
                request.options.headers as ProviderHeaders,
              );
              const context = { ...source, messages: prepared.messages };
              const headers = prepared.headers;
              const requestSampling = scoped.identity;
              const socketScope = createHash("sha256")
                .update(
                  `${p.tenantId}:${p.piSession.id}:${p.piSession.writerId}:${p.piSession.conversationId}:${native.purpose}`,
                )
                .digest("hex");
              if (model.api === "openai-codex-responses") modelSocketScopes.add(socketScope);
              if (
                native.purpose === "agent" ||
                p.input.kind === "compact" ||
                task?.owner !== undefined
              )
                activity.phase(
                  native.purpose === "context_maintenance" ? "compacting" : "waiting_model",
                );
              return {
                model,
                eventIdleTimeoutMs: options.modelEventIdleTimeoutMs ?? MODEL_EVENT_IDLE_MS,
                input: nativeProviderContext(context, model),
                release,
                ...(native.purpose === "agent"
                  ? { onToolCallProgress: () => activity.phase("preparing_tool") }
                  : {}),
                options: {
                  ...request.options,
                  ...(config.transport ? { transport: config.transport } : {}),
                  apiKey: config.apiKey,
                  ...(model.api === "openai-codex-responses"
                    ? { sessionId: socketScope, websocketConnectTimeoutMs: 15_000 }
                    : {}),
                  signal: requestSignal,
                  headers,
                  onPayload: (payload: unknown) =>
                    mergeProviderServiceTier(
                      mergeProviderHostedTools(
                        replayProviderHostedTranscripts(payload, context, model),
                        native.purpose === "agent" ? (config.hostedTools ?? []) : [],
                      ),
                      config.serviceTier,
                    ),
                },
                onHostedActivity,
                onOutcome: (sample) => {
                  options.metrics?.modelDuration.observe(
                    { provider: model.provider, model: model.id, outcome: sample.outcome },
                    sample.durationMs / 1000,
                  );
                  operationalLog({
                    service: "pi-cloud-trusted-runner",
                    level: "info",
                    event: "model.response.timing",
                    attributes: {
                      runId: p.runId,
                      taskId: native.taskId,
                      purpose: native.purpose,
                      conversationId: p.piSession.conversationId,
                      ...(requestSampling
                        ? {
                            stepSequence: requestSampling.stepSequence,
                            stepSha256: requestSampling.stepSha256,
                            samplingAttempt: requestSampling.samplingAttempt,
                          }
                        : {}),
                      provider: model.provider,
                      model: model.id,
                      ...sample,
                    },
                  });
                },
              };
            });
          } catch (error) {
            release();
            throw error;
          }
        },
        ...(options.settlementPolicy
          ? {
              beforeYield: async (answer) =>
                prepareNativeSettlementFollowUp({
                  policy: options.settlementPolicy!,
                  storage: owner.storage,
                  conversationId: p.piSession.conversationId,
                  afterEntry: await runtime.childAnchor(p.piSession.conversationId),
                  answer,
                }),
            }
          : {}),
      };
      const conversation = await runtime.bind(
        binding,
        p.input.kind === "resume" ? "reattach" : "initialize",
      );
      this.#compact = async (request) => {
        combined.throwIfAborted();
        await owner.authority.assertCurrent();
        const receipt = await admitManualCompaction(runtime.harness, owner.storage, conversation, {
          requestId: request.commandId,
          fingerprint: request.fingerprint,
          runId: p.runId,
          requestedAt: request.requestedAt,
          ...(request.instructions ? { instructions: request.instructions } : {}),
        });
        const status = await manualCompactionState(
          runtime.harness,
          conversation.id,
          receipt.requestId,
        );
        if (!status) throw new Error("Committed compact receipt is unavailable");
        return {
          commandId: receipt.requestId,
          replayed: receipt.replayed,
          taskId: receipt.taskId,
          requestedAt: receipt.requestedAt,
          nativeSequence: owner.committedSequence(),
          state: status.state,
        };
      };
      await options.onNativeBound?.();
      stream = await runtime.watch(conversation.id, async (batch) => {
        try {
          for (const event of batch) {
            if (
              p.input.kind !== "compact" &&
              (event.type === "compaction_start" || event.type === "compaction_end") &&
              event.reason === "manual"
            )
              continue;
            activity.event(event);
          }
          for (const event of batch) {
            const bodies: PiCloudEventBody[] = [];
            await frameBodies.run(bodies, () => events.consume([event]));
            if (bodies.length === 0) continue;
            const entry =
              event.type === "message_end" || event.type === "entry_appended"
                ? event.entry
                : event.type === "tool_execution_end"
                  ? event.entry
                  : undefined;
            const sequence = entry ? await owner.recordSequence(entry.id) : undefined;
            for (const [index, body] of bodies.entries())
              await emit(body, index === bodies.length - 1 ? sequence : undefined);
          }
          for (const event of batch) {
            if (event.type === "message_end" || event.type === "entry_appended")
              observedEntry = Math.max(observedEntry, event.entry.id);
            if (event.type === "snapshot")
              for (const entry of event.entries) observedEntry = Math.max(observedEntry, entry.id);
          }
        } catch (error) {
          deliveryFailure ??= error;
        }
        wakeObserved?.();
      });
      observedEntry = Math.max(0, ...stream.snapshot.entries.map((entry) => entry.id));
      events.baseline(stream.snapshot);
      const watching = stream;
      void watching.closed.then((end) => {
        if (end.reason === "listener_error") deliveryFailure ??= end.error;
        wakeObserved?.();
      });
      let aborting: Promise<void> | undefined;
      const abort = () => {
        this.#ended = true;
        if (!["user_request", "timeout"].includes(cancellationReason(combined))) {
          owner.interrupt(new PiTurnError("worker_shutdown", "The native owner is stopping", true));
          return;
        }
        activity.phase("cancelling");
        // Revoked ownership may not write an abort into the next owner's tasks.
        aborting ??= owner.authority
          .assertCurrent()
          .then(() => conversation.abort(BACKGROUND_CONTEXT));
        void aborting.catch(() => undefined);
      };
      combined.addEventListener("abort", abort, { once: true });
      cleanup.push(() => combined.removeEventListener("abort", abort));
      if (p.stopOnResume && !combined.aborted) {
        // The ordinary cancellation executor records its acknowledgement before
        // signaling this assignment. Until then, no resumed task may perform IO.
        this.#ended = true;
        activity.phase("cancelling");
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => {
            dispose();
            resolve();
          };
          const revoked = () => {
            dispose();
            reject(owner.authority.signal.reason);
          };
          const dispose = () => {
            combined.removeEventListener("abort", cancelled);
            owner.authority.signal.removeEventListener("abort", revoked);
          };
          combined.addEventListener("abort", cancelled, { once: true });
          owner.authority.signal.addEventListener("abort", revoked, { once: true });
          if (combined.aborted) cancelled();
          else if (owner.authority.signal.aborted) revoked();
        });
      }
      if (combined.aborted) abort();
      else if (p.input.kind === "compact") {
        await emit({ type: "turn.started", payload: { inputKind: "compact" } });
        await this.#compact({
          ...p.input,
          tenantId: p.tenantId,
          sessionId: p.sessionId,
          runId: p.runId,
          executionReference: p.executionReference,
        });
      } else {
        const existing = await owner.storage.submissionByRequest(
          conversation.id,
          p.runId,
          BACKGROUND_CONTEXT,
        );
        if (!existing) {
          if (p.input.kind === "resume")
            throw new Error("Native child initial Submission is missing");
          await emit({
            type: "turn.started",
            payload: {
              inputKind: "prompt",
              ...(p.scheduledOrigin ? { scheduledOrigin: p.scheduledOrigin } : {}),
            },
          });
          const content = await this.#prepareInput(p.input.text, p.input.uploads, combined);
          await conversation.submit(
            { type: "input", content, requestId: p.runId, whenBusy: "followUp" },
            BACKGROUND_CONTEXT,
          );
        } else runtime.harness.resume();
      }
      this.#humanInputs =
        p.input.kind === "compact"
          ? undefined
          : new DurableHumanInputs({
              conversation,
              runId: p.runId,
              storage: owner.storage,
              sequence: () => owner.committedSequence(),
              assertCurrent: () => owner.authority.assertCurrent(),
              accepting: () => !this.#ended && !combined.aborted,
              prepare: (text, uploads) => this.#prepareInput(text, uploads, combined),
            });
      this.#ready.resolve(conversation);
      const waitContext = withAbortSignal(owner.authority.signal, BACKGROUND_CONTEXT);
      for (;;) {
        const version = this.#inputVersion;
        await conversation.waitForIdle(waitContext);
        if (
          await this.#onInputLine(async () => {
            if (version !== this.#inputVersion) return false;
            this.#ended = true;
            return true;
          })
        )
          break;
      }
      await aborting;
      const final = await conversation.context(BACKGROUND_CONTEXT);
      const through = Math.max(0, ...final.entries.map((entry) => entry.id));
      while (observedEntry < through && !deliveryFailure) {
        await new Promise<void>((resolve) => {
          wakeObserved = resolve;
        });
      }
      await delivery;
      if (deliveryFailure) throw deliveryFailure;
      if (combined.aborted) throw new PiTurnCancelledError(cancellationReason(combined), false);
      if (p.input.kind === "compact") {
        const status = await manualCompactionState(
          runtime.harness,
          conversation.id,
          p.input.commandId,
        );
        if (!status || !["applied", "no_op", "stale"].includes(status.state))
          throw new PiTurnError(
            "compaction_failed",
            "Native compaction did not apply its summary",
            false,
          );
        await owner.authority.assertCurrent();
        await options.onSettled?.();
        return { stopReason: `compact_${status.state}` };
      }
      const rootInput = await owner.storage.submissionByRequest(
        conversation.id,
        p.runId,
        BACKGROUND_CONTEXT,
      );
      const humanInputs = await runtime.harness.snapshot(
        HumanInputDocument,
        conversation.id,
        p.runId,
        BACKGROUND_CONTEXT,
      );
      let cursor: import("@earendil-works/pi-durable").Cursor | undefined = rootInput
        ? { after: rootInput.id - 1 }
        : undefined;
      if (rootInput)
        for (;;) {
          const page = await owner.storage.scanSubmissions(
            { conversationId: conversation.id, status: "unanswered" },
            64,
            cursor,
            BACKGROUND_CONTEXT,
          );
          const input = page.items.find(
            (item) =>
              !(
                item.requestId &&
                humanInputs?.inputs[item.requestId]?.cancelled === true &&
                item.entry === undefined
              ),
          );
          if (input?.status === "unanswered") {
            if (input.reason === "aborted")
              throw new PiTurnError(
                "native_task_aborted",
                "The native task was cancelled through its ownership scope",
                false,
              );
            throw new PiTurnError(
              "native_task_failed",
              "The native task did not complete its accepted input",
              false,
            );
          }
          if (!page.next) break;
          cursor = page.next;
        }
      // The model context intentionally omits some failed/aborted messages.
      // Settlement reads the raw receipt; an older successful answer cannot
      // make a failed new request look completed.
      const assistant = final.entries
        .flatMap((entry) => entry.model ?? [])
        .findLast((message) => message.role === "assistant");
      if (!assistant || assistant.stopReason === "error" || assistant.stopReason === "aborted")
        throw new PiTurnError("model_request_failed", "The model request did not complete", false);
      await owner.authority.assertCurrent();
      await options.onSettled?.();
      if (p.conversationWork)
        await emit(
          { type: "turn.completed", payload: { stopReason: assistant.stopReason } },
          owner.committedSequence(),
        );
      return { stopReason: assistant.stopReason };
    } catch (error) {
      if (handle?.authority.signal.aborted) {
        if (
          (handle.authority.signal.reason as { code?: string })?.code ===
          "native_storage_unavailable"
        )
          throw new PiTurnError(
            "native_storage_unavailable",
            "Native Session data could not be read",
            true,
          );
        if (
          (handle.authority.signal.reason as { code?: string })?.code ===
          "writer_publication_failed"
        )
          throw new PiTurnError(
            "writer_publication_failed",
            "The Session writer stopped after publication failed",
            true,
          );
        throw new PiTurnError(
          "session_lease_revoked",
          "The native owner lost execution authority",
          true,
        );
      }
      if (
        p.conversationWork &&
        handle &&
        !(
          error instanceof PiTurnError &&
          [
            "worker_shutdown",
            "session_lease_revoked",
            "writer_publication_failed",
            "native_storage_unavailable",
          ].includes(error.code)
        )
      ) {
        const cancelled =
          error instanceof PiTurnCancelledError ||
          (error instanceof PiTurnError && error.code === "native_task_aborted");
        await emit(
          cancelled
            ? { type: "turn.cancelled", payload: { reason: "user_request", forced: false } }
            : {
                type: "turn.failed",
                payload: {
                  code: error instanceof PiTurnError ? error.code : "native_task_failed",
                  message: "The native conversation did not complete",
                  retryable: false,
                },
              },
          handle.committedSequence(),
        );
      }
      throw error;
    } finally {
      this.#ended = true;
      this.#ready.reject(
        new PiTurnError("steer_target_unavailable", "Pi Run has closed input delivery", false),
      );
      for (const dispose of cleanup) dispose();
      await stream?.stop();
      await delivery.catch(() => undefined);
      family?.detach(p.runId, p.piSession.conversationId);
      await handle?.close().catch((error) => {
        if (!handle?.authority.signal.aborted) throw error;
      });
      try {
        options.onActivity?.(undefined);
      } catch {
        /* Observation only. */
      }
    }
  }
}
import type { NativeInputCommand, NativeInputResult } from "@pi-cloud/protocol";
import { DurableHumanInputs, HumanInputDocument } from "./durable/human-inputs.ts";
import type { NativeCompactCommand, NativeCompactResult } from "@pi-cloud/protocol";
import { admitManualCompaction, manualCompactionState } from "./durable/manual-compaction.ts";
