import {
  prepareNativeSettlementFollowUp,
  type PiSettlementGatePolicy,
} from "./pi-settlement-gate.ts";
import { fixedRemoteToolDefinitions } from "./fixed-remote-tool-definitions.ts";
import { AsyncLocalStorage } from "node:async_hooks";
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
  inputWithUploads,
  assertUserInputBudget,
  assertPreparedUserInputBudget,
  MAX_INPUT_IMAGE_HINT_BYTES,
  MODEL_STEP_SEQUENCE_HEADER,
  MODEL_STEP_SHA256_HEADER,
  MODEL_SAMPLING_ATTEMPT_HEADER,
  type ExecuteTurnCommandMessage,
  type PiCloudEventBody,
  type UserUpload,
  type RunActivityUpdate,
  type RunInterruptionReason,
} from "@pi-cloud/protocol";
import type { DurableSessionHandle } from "@pi-cloud/pi-session-postgres/durable";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { DurableAgentSession } from "./durable/agent-session.ts";
import { DurableRunEvents } from "./durable/run-events.ts";
import { CloudModelRegistry } from "./durable/model-registry.ts";
import {
  PiSessionWorldStateController,
  type PiSandboxContinuity,
} from "./pi-sandbox-continuity.ts";
import { DurableSampling, type PiSamplingStepCapture } from "./durable/sampling.ts";
import { withToolInvocation } from "./tool-invocation.ts";
import { DurableToolIdentities } from "./durable/tool-identities.ts";
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
  applyProviderHostedTranscript,
  nativeProviderContext,
  replayProviderHostedTranscripts,
} from "./provider-hosted-transcript.ts";
import type {
  AssistantTextPhaseResolver,
  ProviderHostedActivitySubscriber,
  ProviderHostedTranscriptSubscriber,
  ProviderHostedTranscript,
} from "./agent-turn-runtime.ts";

export type PiCloudSessionHandle = DurableSessionHandle;
export type PiCloudTurnRunnerOptions = {
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
  trustedToolDefinitions?: readonly import("@earendil-works/pi-durable").ToolRegistration[];
  acquireModelPermit?: (signal?: AbortSignal) => Promise<() => void>;
  interruptionReason?: () => RunInterruptionReason | undefined;
  metrics?: PiCloudMetrics;
  createAgentTools(context: {
    trackWorkflowOperation: (
      operation: import("./durable/remote-tools.ts").TrackedWorkflowOperation,
    ) => void;
    stepWorldState: PiSessionWorldStateController;
    captureSamplingStep(
      createFresh: (sequence: number) => Promise<Omit<PiSamplingStepCapture, "samplingAttempt">>,
      options?: { publishEvent?: boolean },
    ): Promise<PiSamplingStepCapture>;
  }): TrustedRemoteAgentTools;
  sandboxContinuity: PiSandboxContinuity;
  onSettled?: () => Promise<void> | void;
  onActivity?: (update: RunActivityUpdate | undefined) => void;
  subscribeHostedActivity?: ProviderHostedActivitySubscriber;
  resolveAssistantTextPhase?: AssistantTextPhaseResolver;
  subscribeHostedTranscript?: ProviderHostedTranscriptSubscriber;
  settlementPolicy?: PiSettlementGatePolicy;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

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
function hostedKey(headers: ProviderHeaders): string {
  return [MODEL_STEP_SEQUENCE_HEADER, MODEL_STEP_SHA256_HEADER, MODEL_SAMPLING_ATTEMPT_HEADER]
    .map((key) => headers[key])
    .join(":");
}

/** One admitted logical Run on the family's native Harness. Pi owns execution,
 * submission placement, abort, retry and checkpoints; this class supplies ports. */
export class PiCloudTurnRunner {
  readonly #options: PiCloudTurnRunnerOptions;
  readonly #ready = Promise.withResolvers<Conversation>();
  #ended = false;
  #inputVersion = 0;
  #inputLine: Promise<unknown> = Promise.resolve();
  constructor(options: PiCloudTurnRunnerOptions) {
    this.#options = options;
    void this.#ready.promise.catch(() => undefined);
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
  steer(text: string, inputId: string, uploads?: readonly UserUpload[]): Promise<void> {
    return this.agentInput(inputId, text, "steer", uploads);
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
    if (p.input.kind !== "prompt")
      throw new PiTurnError("unsupported_input", "Pi supports prompt input", false);
    const clock = options.clock ?? (() => new Date()),
      id = options.idGenerator ?? (() => crypto.randomUUID());
    const activity = new PiRunActivity(options.onActivity);
    activity.phase("preparing");
    const timeout = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = p.stopOnResume
      ? undefined
      : setTimeout(
          () =>
            timeout.abort({
              kind: "pi-cloud.turn-cancellation",
              reason: "timeout",
              gracePeriodMs: 0,
            }),
          positiveInteger(options.turnTimeoutMs ?? 30000, "turnTimeoutMs"),
        );
    timer?.unref();
    let handle: DurableSessionHandle | undefined,
      family: DurableAgentSession | undefined,
      stream: AgentEventStream | undefined;
    const cleanup: (() => void)[] = [];
    let delivery = Promise.resolve(),
      deliveryFailure: unknown;
    const factory = createPiCloudEventFactory(
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
      const event = factory.next(body);
      delivery = delivery.then(async () => {
        await publishEvent({
          protocolVersion: 1,
          messageId: id(),
          sentAt: validDate(clock).toISOString(),
          type: "event.publish",
          payload: {
            executionReference: p.executionReference,
            event,
            ...(nativeSequence === undefined ? {} : { nativeSequence }),
          },
        });
      });
      void delivery.catch((error) => {
        deliveryFailure ??= error;
      });
      return delivery;
    };
    try {
      const config = validateRuntimeConfig(command, await options.resolveModelRuntime(p.model));
      handle = await options.openSession(command, combined);
      const owner = handle;
      const registry = options.modelRegistry ?? sharedModels;
      const model = registry.configure(config);
      // Schemas are code-owned; constructing them does not access a guest.
      family = await owner.runtime(async () => {
        const runtime = await DurableAgentSession.open(owner.storage, {
          models: registry.models,
          remoteTools: fixedRemoteToolDefinitions(),
          infrastructureTools: options.trustedToolDefinitions ?? [],
          settings: {
            stream: {
              timeoutMs: options.requestTimeoutMs ?? 10000,
              ...(config.transport ? { transport: config.transport } : {}),
            },
            compaction: {
              reserveTokens: p.budgets?.compactionReserveTokens ?? 16384,
              keepRecentTokens: p.budgets?.compactionKeepRecentTokens ?? 20000,
            },
          },
        });
        owner.preparePublication((commit) => runtime.remote.preparePublication(commit));
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
      const invocations = new DurableToolIdentities(owner.storage),
        sampling = new DurableSampling();
      let observedEntry = 0,
        wakeObserved: (() => void) | undefined;
      const events = new DurableRunEvents({
        writerId: p.piSession.writerId,
        emit,
        toolId: (callId, assistant, result) => invocations.resolve(callId, assistant, result),
        ...(options.resolveAssistantTextPhase ? { phase: options.resolveAssistantTextPhase } : {}),
        maximumToolOutputBytes: p.budgets?.maximumToolOutputBytes ?? 65536,
        retryAttempts: 4,
        task: (taskId) => runtime.harness.getTask(taskId as TaskId, BACKGROUND_CONTEXT),
      });
      const tools = options.createAgentTools({
        trackWorkflowOperation: (operation) => runtime.remote.trackWorkflow(operation),
        stepWorldState: world,
        captureSamplingStep: async (fresh, capture) => {
          const step = await sampling.capture(fresh);
          if (capture?.publishEvent !== false && sampling.publish) {
            await events.samplingStarted({
              stepSequence: step.step.context.sequence,
              stepSha256: step.step.sha256,
              samplingAttempt: step.samplingAttempt,
            });
          }
          return step;
        },
      });
      const transcripts = new Map<string, ProviderHostedTranscript>();
      const unsubscribeTranscript = options.subscribeHostedTranscript?.((value) => {
        transcripts.set(
          `${value.stepSequence}:${value.stepSha256}:${value.samplingAttempt}`,
          value,
        );
      });
      if (unsubscribeTranscript) cleanup.push(unsubscribeTranscript);
      const unsubscribeActivity = options.subscribeHostedActivity?.((value) => {
        void emit({
          type:
            value.phase === "started"
              ? "provider.hosted_tool.started"
              : "provider.hosted_tool.completed",
          payload: {
            toolName: value.toolName,
            activityId: value.activityId,
            ...(value.phase === "completed" ? { outcome: value.outcome } : {}),
          },
        } as PiCloudEventBody).catch(() => undefined);
      });
      if (unsubscribeActivity) cleanup.push(unsubscribeActivity);
      const prompt = [
        languageAlignmentInstruction(p.input.text),
        BASE_SYSTEM_PROMPT,
        p.agentSystemPrompt,
      ]
        .filter(Boolean)
        .join("\n\n");
      const conversation = await runtime.bind({
        runId: p.runId,
        conversationId: p.piSession.conversationId,
        model,
        ...(config.autoCompactTokenLimit === undefined
          ? {}
          : { autoCompactTokenLimit: config.autoCompactTokenLimit }),
        context: { sessionId: p.sessionId, turnId: p.turnId },
        agent: {
          instructions: await tools.systemPrompt(prompt),
          cwd: p.workingDirectory,
          thinkingLevel: p.model.thinkingLevel,
        },
        remoteTools: tools.tools.filter((tool) => tool.prepareExecution).map((tool) => tool.name),
        tools: tools.tools.filter((tool) => !tool.prepareExecution),
        assertCurrent: () => owner.authority.assertCurrent(),
        ...(p.stopOnResume
          ? {
              beforeEffect: async (effectSignal?: AbortSignal) => {
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
          if (!tool?.prepareExecution) throw new Error("Remote Tool has no preparation port");
          return withToolInvocation(
            {
              id: `task:${invocation.taskId}`,
              nativeToolCallId: invocation.callId,
            },
            () =>
              tool.prepareExecution!(
                invocation.callId,
                invocation.args,
                invocation.context.abortSignal,
              ),
          );
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
            sampling.select({
              sequence,
              attempt: checkpoint.attempt ?? 1,
              publish: native.purpose === "agent",
            });
            const source = request.input as ModelContext;
            const messages = await tools.transformContext(
              source.messages,
              native?.purpose ?? "agent",
            );
            const context = { ...source, messages };
            const headers = await tools.transformHeaders(
              request.options.headers as ProviderHeaders,
            );
            const key = hostedKey(headers);
            activity.phase(
              native?.purpose === "context_maintenance" ? "compacting" : "waiting_model",
            );
            return {
              model,
              input: nativeProviderContext(context),
              release,
              options: {
                ...request.options,
                apiKey: config.apiKey,
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
              decorate: (message) => {
                const transcript = transcripts.get(key);
                if (transcript) applyProviderHostedTranscript(message, transcript);
                transcripts.delete(key);
              },
            };
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
      });
      stream = await runtime.watch(conversation.id, async (batch) => {
        try {
          for (const event of batch) {
            activity.event(event);
          }
          for (const event of batch) {
            const bodies: PiCloudEventBody[] = [];
            await frameBodies.run(bodies, () => events.consume([event]));
            const entry =
              event.type === "message_end"
                ? event.entry
                : event.type === "tool_execution_end"
                  ? event.entry
                  : undefined;
            const sequence = entry
              ? (await owner.storage.entry(entry.id, BACKGROUND_CONTEXT))?.commitSeq
              : undefined;
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
      else {
        const existing = await owner.storage.submissionByRequest(
          conversation.id,
          p.runId,
          BACKGROUND_CONTEXT,
        );
        if (!existing) {
          await emit({ type: "turn.started", payload: { inputKind: "prompt" } });
          const content = await this.#prepareInput(p.input.text, p.input.uploads, combined);
          await conversation.submit(
            { type: "input", content, requestId: p.runId, whenBusy: "followUp" },
            BACKGROUND_CONTEXT,
          );
        } else runtime.harness.resume();
      }
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
      const rootInput = await owner.storage.submissionByRequest(
        conversation.id,
        p.runId,
        BACKGROUND_CONTEXT,
      );
      const unanswered = rootInput
        ? await owner.storage.scanSubmissions(
            { conversationId: conversation.id, status: "unanswered" },
            1,
            { after: rootInput.id - 1 },
            BACKGROUND_CONTEXT,
          )
        : undefined;
      if (unanswered?.items.length) {
        const input = unanswered.items[0]!;
        if (input.status === "unanswered" && input.reason === "aborted")
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
      return { stopReason: assistant.stopReason };
    } catch (error) {
      if (handle?.authority.signal.aborted)
        throw new PiTurnError(
          "session_lease_revoked",
          "The native owner lost execution authority",
          true,
        );
      throw error;
    } finally {
      this.#ended = true;
      this.#ready.reject(
        new PiTurnError("steer_target_unavailable", "Pi Run has closed input delivery", false),
      );
      clearTimeout(timer);
      for (const dispose of cleanup) dispose();
      await stream?.stop();
      await delivery.catch(() => undefined);
      family?.detach(p.runId);
      await handle?.close();
      try {
        options.onActivity?.(undefined);
      } catch {
        /* Observation only. */
      }
    }
  }
}
