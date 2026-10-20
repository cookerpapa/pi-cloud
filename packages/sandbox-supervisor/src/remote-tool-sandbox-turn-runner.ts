import type { WorkflowPreparer } from "./workflow-transport.ts";
import {
  awaitWithContext,
  withAbortSignal,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import { isDeepStrictEqual } from "node:util";
import {
  activeTraceCarrier,
  operationalLog,
  withSpan,
  type PiCloudMetrics,
} from "@pi-cloud/observability";
import {
  type ExecuteTurnCommandMessage,
  parseExecutionReference,
  interruptionReasonForFailureCode,
  type ToolSandboxAssignment,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type ConversationWorkView,
  type ConversationStartRequest,
} from "@pi-cloud/protocol";
import { encodeWorkspaceBlob } from "@pi-cloud/workspace-runtime";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorTurnRunner } from "./agent-run-supervisor.ts";
import { PiTurnError, type PiEventPublisher, type PiTurnResult } from "./pi-turn-runtime.ts";
import {
  PiCloudTurnRunner,
  type PiCloudSessionHandle,
  type PiCloudTurnRunnerOptions,
} from "./pi-cloud-turn-runner.ts";
import { settlementGatePolicyFromCommand } from "./pi-settlement-gate.ts";
import { validateSandboxRuntimeIdentity, type SandboxRuntimeIdentity } from "@pi-cloud/protocol";
import type {
  AgentWorkspaceSeedResolver,
  TrustedAgentTool,
  TrustedModelRuntimeLease,
  TrustedModelRuntimeLeaseResolver,
} from "./agent-turn-runtime.ts";
import {
  createTrustedRemoteAgentTools,
  type TrustedRemoteToolsRuntimeConfiguration,
} from "./trusted-remote-tools.ts";
import {
  createCloudExecutionContext,
  createCloudStepContext,
  createCloudTurnContext,
} from "./cloud-context.ts";

export interface SandboxControlBoundary {
  prepareInputImages?(
    activationId: string,
    assignment: ToolSandboxAssignment,
    images: import("@pi-cloud/protocol").ImageAttachmentReference[],
    signal?: AbortSignal,
  ): Promise<
    {
      sourceId: string;
      image: import("@pi-cloud/protocol").ImageAttachmentReference;
      hints: string[];
    }[]
  >;
  refreshServices(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;
  create(
    request: ToolSandboxCreateRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxCreateResponse>;
  release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition: { kind: "detach" | "keep_warm" | "destroy"; cancelOutstanding?: true },
  ): Promise<{ retained: boolean }>;
  workflowUrlFor(activationId: string): string;
}

export type RemoteToolSandboxTurnRunnerOptions = {
  conversations?: {
    createChildConversation(input: {
      executionReference: string;
      requestId: string;
      ownerTaskId: number;
      parentConversationId: number;
      at: string | null;
      view: ConversationWorkView;
    }): Promise<number>;
    stopConversation(reference: string, requestId: string): Promise<void>;
    inputReceipt(reference: string, conversationId: number, requestId: string): Promise<boolean>;
    activeConversations(reference: string): Promise<
      Array<{
        conversationId: number;
        view: ConversationWorkView;
        nextEventSeq: number;
      }>
    >;
  };
  openConversationLog?: (command: ExecuteTurnCommandMessage) => {
    publish: PiEventPublisher;
    close(): Promise<void>;
  };
  onRuntimeBinding?: (
    executionReference: string,
    bindingId: string | undefined,
    conversationId: number,
  ) => void;
  onActivity?: (
    command: ExecuteTurnCommandMessage,
    update: import("@pi-cloud/protocol").RunActivityUpdate | undefined,
  ) => void;
  decodeInputImages?: (
    images: import("@pi-cloud/protocol").ImageAttachmentReference[],
    scope: { tenantId: string; runId: string },
    signal?: AbortSignal,
  ) => Promise<import("@earendil-works/pi-ai").ImageContent[]>;
  broker: SandboxControlBoundary;
  runtimeIdentity: SandboxRuntimeIdentity;
  trustedWorkspaceDirectory: string;
  modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver;
  workspaceSeedResolver?: AgentWorkspaceSeedResolver;
  openAgentSession: (
    command: ExecuteTurnCommandMessage,
    readSignal?: AbortSignal,
  ) => Promise<PiCloudSessionHandle>;
  waitForToolReply?: TrustedRemoteToolsRuntimeConfiguration["waitForToolReply"];
  confirmExecution?: (
    command: ExecuteTurnCommandMessage,
    bindingId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  createTrustedTools?: (
    command: ExecuteTurnCommandMessage,
    context: Readonly<{
      prepareWorkflow: WorkflowPreparer;
      prepareEnvironment(): Promise<string>;
    }>,
  ) => Promise<readonly TrustedAgentTool[]> | readonly TrustedAgentTool[];
  acquireModelPermit?: (
    command: ExecuteTurnCommandMessage,
    signal?: AbortSignal,
  ) => Promise<() => void>;
  requestTimeoutMs?: number;
  idGenerator?: () => string;
  metrics?: PiCloudMetrics;
};

function assignment(
  command: ExecuteTurnCommandMessage,
  runtimeIdentity: SandboxRuntimeIdentity,
): ToolSandboxAssignment {
  return {
    tenantId: command.payload.tenantId,
    projectId: command.payload.projectId,
    workspaceId: command.payload.workspaceId,
    ...runtimeIdentity,
    runId: command.payload.runId,
    sessionId: command.payload.sessionId,
    turnId: command.payload.turnId,
    executionReference: command.payload.executionReference,
  };
}

function safePiError(error: unknown, fallbackCode: string, fallbackMessage: string): PiTurnError {
  if (error instanceof PiTurnError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return new PiTurnError(error.code, fallbackMessage, error.retryable);
  }
  return new PiTurnError(fallbackCode, fallbackMessage, true);
}

async function releaseModelRuntimeLease(lease: TrustedModelRuntimeLease): Promise<void> {
  await lease.release();
}

export class RemoteToolSandboxTurnRunner implements SupervisorTurnRunner {
  readonly #conversationHost: RemoteToolSandboxTurnRunnerOptions["conversations"];
  readonly #openConversationLog: RemoteToolSandboxTurnRunnerOptions["openConversationLog"];
  readonly #families = new Map<
    string,
    {
      command: ExecuteTurnCommandMessage;
      signal: AbortSignal;
      bindingsReady: PromiseWithResolvers<void>;
      children: Map<
        string,
        {
          conversationId: number;
          view: ConversationWorkView;
          ready: Promise<void>;
          done: Promise<unknown>;
        }
      >;
    }
  >();
  readonly #conversationLines = new Map<string, Promise<unknown>>();
  readonly #broker: SandboxControlBoundary;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #trustedWorkspaceDirectory: string;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver;
  readonly #workspaceSeedResolver: AgentWorkspaceSeedResolver | undefined;
  readonly #openAgentSession: RemoteToolSandboxTurnRunnerOptions["openAgentSession"];
  readonly #waitForToolReply: RemoteToolSandboxTurnRunnerOptions["waitForToolReply"];
  readonly #confirmExecution: RemoteToolSandboxTurnRunnerOptions["confirmExecution"];
  readonly #decodeInputImages: RemoteToolSandboxTurnRunnerOptions["decodeInputImages"];
  readonly #createTrustedTools: RemoteToolSandboxTurnRunnerOptions["createTrustedTools"];
  readonly #acquireModelPermit: RemoteToolSandboxTurnRunnerOptions["acquireModelPermit"];
  readonly #onActivity: RemoteToolSandboxTurnRunnerOptions["onActivity"];
  readonly #onRuntimeBinding: RemoteToolSandboxTurnRunnerOptions["onRuntimeBinding"];
  readonly #requestTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #activePiRunners = new Map<
    string,
    {
      ready: Promise<PiCloudTurnRunner>;
      executionReference: string;
      resolve: (runner: PiCloudTurnRunner) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: RemoteToolSandboxTurnRunnerOptions) {
    this.#conversationHost = options.conversations;
    this.#openConversationLog = options.openConversationLog;
    this.#onActivity = options.onActivity;
    this.#onRuntimeBinding = options.onRuntimeBinding;
    this.#broker = options.broker;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#openAgentSession = options.openAgentSession;
    this.#waitForToolReply = options.waitForToolReply;
    this.#confirmExecution = options.confirmExecution;
    this.#decodeInputImages = options.decodeInputImages;
    this.#createTrustedTools = options.createTrustedTools;
    this.#acquireModelPermit = options.acquireModelPermit;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#metrics = options.metrics;
  }

  warm(): Promise<void> {
    return Promise.resolve();
  }

  async run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal: AbortSignal,
  ): Promise<PiTurnResult> {
    const key = `${command.payload.runId}:${command.payload.piSession.conversationId}`;
    const root = !command.payload.conversationWork;
    if (this.#activePiRunners.has(key)) {
      throw new PiTurnError(
        "pi_runtime_overlap",
        "Pi Runtime is already active for this Run",
        false,
      );
    }
    let resolveRunner!: (runner: PiCloudTurnRunner) => void;
    let rejectRunner!: (error: Error) => void;
    const ready = new Promise<PiCloudTurnRunner>((resolvePromise, rejectPromise) => {
      resolveRunner = resolvePromise;
      rejectRunner = rejectPromise;
    });
    void ready.catch(() => undefined);
    const slot = {
      ready,
      resolve: resolveRunner,
      reject: rejectRunner,
      executionReference: command.payload.executionReference,
    };
    this.#activePiRunners.set(key, slot);
    if (root) {
      const bindingsReady = Promise.withResolvers<void>();
      void bindingsReady.promise.catch(() => {});
      this.#families.set(command.payload.executionReference, {
        command,
        signal,
        bindingsReady,
        children: new Map(),
      });
    }
    try {
      return await withSpan({
        serviceName: "pi-cloud-trusted-runner",
        name: "run.execute",
        ...(command.payload.traceContext === undefined
          ? {}
          : { parent: command.payload.traceContext }),
        attributes: {
          "pi_cloud.run.id": command.payload.runId,
          "pi_cloud.execution.id": parseExecutionReference(command.payload.executionReference)
            .runId,
          "pi_cloud.session.id": command.payload.sessionId,
        },
        run: () => this.#run(command, publishEvent, signal, slot.resolve),
      });
    } finally {
      if (root) {
        const family = this.#families.get(command.payload.executionReference);
        family?.bindingsReady.reject(
          new Error("Root work ended before native bindings were ready"),
        );
        const outcomes = family
          ? await Promise.allSettled([...family.children.values()].map((child) => child.done))
          : [];
        this.#families.delete(command.payload.executionReference);
        const failure = outcomes.find(
          (outcome) =>
            outcome.status === "rejected" &&
            outcome.reason instanceof PiTurnError &&
            [
              "writer_publication_failed",
              "worker_shutdown",
              "session_lease_revoked",
              "native_storage_unavailable",
            ].includes(outcome.reason.code),
        );
        if (failure?.status === "rejected") {
          this.#activePiRunners.delete(key);
          slot.reject(failure.reason);
          throw failure.reason;
        }
      }
      if (this.#activePiRunners.get(key) === slot) {
        this.#activePiRunners.delete(key);
      }
      slot.reject(
        new PiTurnError(
          "steer_target_unavailable",
          "Pi Run ended before the steer could be delivered",
          false,
        ),
      );
    }
  }
  async #conversationLine<T>(reference: string, id: string, action: () => Promise<T>): Promise<T> {
    const key = `${reference}:${id}`,
      prior = this.#conversationLines.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.#conversationLines.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#conversationLines.get(key) === next) this.#conversationLines.delete(key);
    }
  }
  startConversation(request: ConversationStartRequest): Promise<number> {
    return this.#attachConversation({
      ...request,
      input: { kind: "prompt", text: request.prompt },
    });
  }
  restoreConversation(
    reference: string,
    child: { conversationId: number; view: ConversationWorkView; nextEventSeq: number },
  ): Promise<number> {
    return this.#attachConversation({
      executionReference: reference,
      view: child.view,
      input: { kind: "resume" },
      restored: child,
    });
  }
  #attachConversation(
    request: {
      executionReference: string;
      view: ConversationWorkView;
    } & (
      | { input: { kind: "prompt"; text: string }; restored?: never }
      | {
          input: { kind: "resume" };
          restored: { conversationId: number; nextEventSeq: number };
        }
    ),
  ): Promise<number> {
    const restored = request.restored;
    return this.#conversationLine(request.executionReference, request.view.id, async () => {
      const family = this.#families.get(request.executionReference);
      if (!family || !this.#conversationHost || !this.#openConversationLog)
        throw Object.assign(new Error("Native Session owner is unavailable"), { retryable: true });
      const prior = family.children.get(request.view.id);
      if (prior) {
        if (!isDeepStrictEqual(prior.view, request.view))
          throw new Error("Child view identity changed");
        await prior.ready;
        return prior.conversationId;
      }
      const view = request.view;
      const conversationId =
        restored?.conversationId ??
        (await this.#conversationHost.createChildConversation({
          executionReference: request.executionReference,
          requestId: view.id,
          parentConversationId: view.parentConversationId,
          ownerTaskId: view.ownerTaskId,
          at: view.contextAnchor === null ? null : String(view.contextAnchor),
          view,
        }));
      const { computeSessionId: _compute, ...rootPayload } = family.command.payload;
      const command: ExecuteTurnCommandMessage = {
        ...family.command,
        messageId: this.#idGenerator(),
        payload: {
          ...rootPayload,
          sessionId: view.sessionId,
          turnId: view.turnId,
          piSession: { ...rootPayload.piSession, conversationId },
          conversationWork: view,
          sessionKind: "subagent",
          nextEventSeq: restored?.nextEventSeq ?? 1,
          input: request.input,
          workingDirectory: view.workingDirectory,
          toolCapabilities: view.toolCapabilities,
          agentSystemPrompt: view.agentSystemPrompt,
          ...(view.computeSessionId ? { computeSessionId: view.computeSessionId } : {}),
        },
      };
      const log = this.#openConversationLog(command);
      const work = this.run(command, log.publish, family.signal);
      const slot = this.#activePiRunners.get(`${command.payload.runId}:${conversationId}`)!;
      const ready = slot.ready.then((runner) => runner.waitUntilReady());
      const done = work.then(
        async (result) => {
          await log.close().catch(() => {
            throw new PiTurnError(
              "writer_publication_failed",
              "Conversation publication did not drain",
              true,
            );
          });
          return result;
        },
        async (error: unknown) => {
          await log.close().catch(() => {});
          throw error;
        },
      );
      void done.catch(() => {});
      family.children.set(view.id, { conversationId, view: structuredClone(view), ready, done });
      await ready;
      return conversationId;
    });
  }
  stopConversation(reference: string, id: string): Promise<void> {
    return this.#conversationLine(reference, id, async () => {
      if (!this.#families.has(reference) || !this.#conversationHost)
        throw Object.assign(new Error("Native Session owner is unavailable"), { retryable: true });
      await this.#conversationHost.stopConversation(reference, id);
    });
  }
  async agentInput(
    runId: string,
    id: string,
    text: string,
    delivery: "notify" | "steer" | "follow_up",
    executionReference: string,
    conversationId: number,
  ): Promise<{ accepted: boolean }> {
    const key = `${runId}:${conversationId}`;
    const slot = this.#activePiRunners.get(key);
    const receipt = async () => ({
      accepted:
        (await this.#conversationHost?.inputReceipt(executionReference, conversationId, id)) ??
        false,
    });
    if (!slot) return receipt();
    if (slot.executionReference !== executionReference)
      throw new Error("Target Agent input authority mismatch");
    const runner = await slot.ready;
    if (this.#activePiRunners.get(key) !== slot) return receipt();
    try {
      await runner.agentInput(id, text, delivery);
    } catch (error) {
      if (error instanceof PiTurnError && error.code === "steer_target_unavailable")
        return receipt();
      throw error;
    }
    return { accepted: true };
  }
  async humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
    const key = `${command.runId}:1`;
    const slot = this.#activePiRunners.get(key);
    if (!slot || slot.executionReference !== command.executionReference)
      throw new PiTurnError(
        "input_target_unavailable",
        "Input target has no current Worker execution",
        true,
      );
    const runner = await slot.ready;
    if (this.#activePiRunners.get(key) !== slot)
      throw new PiTurnError("input_target_unavailable", "Input target ended during delivery", true);
    return runner.humanInput(command);
  }

  async #run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal: AbortSignal,
    onPiRunnerReady: (runner: PiCloudTurnRunner) => void,
  ): Promise<PiTurnResult> {
    if (
      command.payload.agent.runtimeKind !== "pi_sdk" ||
      command.payload.agent.sessionStorageKind !== "pi_durable_storage_v1"
    ) {
      throw new PiTurnError(
        "agent_runtime_unsupported",
        "This Worker cannot execute the Session's Agent revision",
        false,
      );
    }
    const downstreamTrace = activeTraceCarrier() ?? command.payload.traceContext;
    const trustedWorkspace = await stat(this.#trustedWorkspaceDirectory).catch(() => undefined);
    if (!trustedWorkspace?.isDirectory()) {
      throw new PiTurnError(
        "trusted_runner_workspace_unavailable",
        "Trusted Agent Runner virtual workspace is unavailable",
        true,
      );
    }

    let workspaceSeed: Uint8Array | undefined;
    if (this.#workspaceSeedResolver !== undefined) {
      try {
        workspaceSeed = await this.#workspaceSeedResolver(command);
      } catch (error: unknown) {
        throw safePiError(
          error,
          "workspace_seed_unavailable",
          "Workspace source could not be provisioned",
        );
      }
    }
    const cloudTurn = createCloudTurnContext(command);

    const modelGrant = new AbortController();
    const modelGrantSignal = signal
      ? AbortSignal.any([signal, modelGrant.signal])
      : modelGrant.signal;
    const modelRuntimeLease = await this.#modelRuntimeLeaseResolver(command, modelGrantSignal);
    let detachModelOwner: (() => void) | undefined;
    if (
      modelRuntimeLease.runtime.provider !== command.payload.model.provider ||
      modelRuntimeLease.runtime.modelId !== command.payload.model.modelId
    ) {
      await releaseModelRuntimeLease(modelRuntimeLease).catch(() => undefined);
      throw new PiTurnError(
        "model_binding_mismatch",
        "Resolved model runtime does not match the accepted turn",
        false,
      );
    }
    const toolAssignment = assignment(command, this.#runtimeIdentity);
    const cloudExecution = createCloudExecutionContext({
      command,
      runtimeIdentity: this.#runtimeIdentity,
      turnContextSha256: cloudTurn.sha256,
    });
    const createRequest: ToolSandboxCreateRequest = {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: this.#idGenerator(),
      assignment: toolAssignment,
      turnContextSha256: cloudTurn.sha256,
      executionContextSha256: cloudExecution.sha256,
      allowedTools: cloudTurn.context.tools.names,
      executionMode: command.payload.executionMode,
      ...(command.payload.computeSessionId === undefined
        ? {}
        : { computeSessionId: command.payload.computeSessionId }),
      sandboxProfileKey: command.payload.sandboxProfileKey,
      toolRoot: command.payload.workingDirectory,
      environment: command.payload.environment,
      workspaceSeed:
        workspaceSeed === undefined
          ? { kind: "sample_java" }
          : { kind: "bundle", bundle: encodeWorkspaceBlob(workspaceSeed) },
    };
    const inputPreparationAbort = new AbortController();
    const inputPreparations = new Set<Promise<unknown>>();
    let activation: ToolSandboxCreateResponse | undefined;
    let activationPromise: Promise<ToolSandboxCreateResponse> | undefined;
    let executionError: unknown;
    let toolRuntimeFailure: PiTurnError | undefined;
    let cancelOutstanding = false;
    const ensureActivation = async (): Promise<ToolSandboxCreateResponse> => {
      if (signal.aborted) throw signal.reason;
      if (toolRuntimeFailure !== undefined) throw toolRuntimeFailure;
      if (activation !== undefined) return activation;
      activationPromise ??= (async () => {
        const createStartedAt = performance.now();
        try {
          const created = await this.#broker.create(createRequest, signal);
          activation = created;
          try {
            this.#onRuntimeBinding?.(
              command.payload.executionReference,
              created.activationId,
              command.payload.piSession.conversationId,
            );
          } catch {
            /* Observation only. */
          }
          this.#metrics?.sandboxDuration.observe(
            { operation: "reserve", outcome: "completed" },
            (performance.now() - createStartedAt) / 1_000,
          );
          if (signal.aborted) {
            throw signal.reason;
          }
          return created;
        } catch (error: unknown) {
          this.#metrics?.sandboxDuration.observe(
            { operation: "reserve", outcome: "failed" },
            (performance.now() - createStartedAt) / 1_000,
          );
          throw safePiError(
            error,
            "tool_sandbox_reservation_failed",
            "Tool Sandbox authority could not be reserved",
          );
        }
      })();
      return activationPromise;
    };

    try {
      // Both execution modes bind on the first actual Sandbox Tool. A pure
      // chat must not reserve machine authority or depend on Broker uptime.
      // recordActive receives the actual binding before the next clean Step.

      const resolveModelRuntime: PiCloudTurnRunnerOptions["resolveModelRuntime"] = () => ({
        provider: modelRuntimeLease.runtime.provider,
        modelId: modelRuntimeLease.runtime.modelId,
        baseUrl: modelRuntimeLease.runtime.baseUrl,
        api: modelRuntimeLease.runtime.api,
        apiKey: modelRuntimeLease.runtime.capability,
        ...(modelRuntimeLease.runtime.api === "openai-codex-responses"
          ? { transport: "sse" as const }
          : {}),
        ...(modelRuntimeLease.runtime.reasoning === undefined
          ? {}
          : { reasoning: modelRuntimeLease.runtime.reasoning }),
        ...(modelRuntimeLease.runtime.contextWindow === undefined
          ? {}
          : { contextWindow: modelRuntimeLease.runtime.contextWindow }),
        autoCompactTokenLimit: modelRuntimeLease.runtime.autoCompactTokenLimit,
        ...(modelRuntimeLease.runtime.maxTokens === undefined
          ? {}
          : { maxTokens: modelRuntimeLease.runtime.maxTokens }),
        inputModalities: modelRuntimeLease.runtime.inputModalities,
        hostedTools: modelRuntimeLease.runtime.hostedTools,
        serviceTier: modelRuntimeLease.runtime.serviceTier,
      });
      const onSettled = () => {
        if (toolRuntimeFailure !== undefined) throw toolRuntimeFailure;
      };
      const settlementPolicy = settlementGatePolicyFromCommand(command);
      let prepareWorkflow: WorkflowPreparer | undefined;
      const trustedToolBindings =
        (await this.#createTrustedTools?.(command, {
          prepareWorkflow: (...args) => {
            if (!prepareWorkflow) throw new Error("Remote workflow runtime is not ready");
            return prepareWorkflow(...args);
          },
          prepareEnvironment: async () => (await ensureActivation()).activationId,
        })) ?? ([] as readonly TrustedAgentTool[]);
      const trustedTools = trustedToolBindings
        .filter((binding) => binding.offered !== false)
        .map((binding) => binding.tool);
      const hasDelegationTool = trustedTools.some((tool) => tool.name === "subagent");
      const hasSupervisorContact = trustedTools.some((tool) => tool.name === "contact_supervisor");
      let activeSession: PiCloudSessionHandle | undefined;
      const commonRunnerOptions = {
        trustedToolDefinitions: trustedToolBindings.map((binding) => binding.tool),
        onActivity: (update: import("@pi-cloud/protocol").RunActivityUpdate | undefined) =>
          this.#onActivity?.(command, update),
        resolveModelRuntime,
        openSession: async (command: ExecuteTurnCommandMessage, readSignal?: AbortSignal) => {
          activeSession = await this.#openAgentSession(command, readSignal);
          const ownerSignal = activeSession.authority.signal;
          const revoke = () => modelGrant.abort(ownerSignal.reason);
          ownerSignal.addEventListener("abort", revoke, { once: true });
          detachModelOwner = () => ownerSignal.removeEventListener("abort", revoke);
          if (ownerSignal.aborted) revoke();
          return activeSession;
        },
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
        sandboxContinuity: {
          continuityId:
            activation?.continuityId ??
            parseExecutionReference(command.payload.executionReference).runId,
          continuity: activation?.continuity ?? "cold_restore",
          environmentSha256: cloudTurn.environmentSha256,
          workspaceBindingSha256: cloudTurn.workspaceBindingSha256,
          toolPolicySha256: cloudTurn.toolPolicySha256,
        },
        onSettled,
        ...(this.#requestTimeoutMs === undefined
          ? {
              requestTimeoutMs: modelRuntimeLease.runtime.requestTimeoutMs,
            }
          : { requestTimeoutMs: this.#requestTimeoutMs }),
      };
      let recordPreparedInput: (() => Promise<void>) | undefined;
      const runner = new PiCloudTurnRunner({
        beforeEffect: async (effectSignal) => {
          const family = this.#families.get(command.payload.executionReference);
          if (!family) throw new Error("Native Session work is closing");
          await awaitWithContext(
            family.bindingsReady.promise,
            withAbortSignal(effectSignal ?? signal, BACKGROUND_CONTEXT),
          );
        },
        ...(!command.payload.conversationWork
          ? {
              onNativeBound: async () => {
                const family = this.#families.get(command.payload.executionReference)!;
                try {
                  for (const child of (await this.#conversationHost?.activeConversations(
                    command.payload.executionReference,
                  )) ?? [])
                    await this.restoreConversation(command.payload.executionReference, child);
                  family.bindingsReady.resolve();
                } catch (error) {
                  family.bindingsReady.reject(error);
                  throw error;
                }
              },
            }
          : {}),
        prepareInputUploads: (uploads, inputSignal) => {
          const preparing = (async () => {
            const sources = uploads.flatMap((file) => (file.image ? [file.image] : []));
            if (!sources.length) return { images: [], hints: [] };
            if (
              !modelRuntimeLease.runtime.inputModalities.includes("image") ||
              !this.#broker.prepareInputImages ||
              !this.#decodeInputImages
            )
              throw new PiTurnError(
                "input_images_unavailable",
                "The model or runtime cannot receive input images",
                false,
              );
            const combined = AbortSignal.any([
              signal,
              inputPreparationAbort.signal,
              ...(inputSignal ? [inputSignal] : []),
            ]);
            combined.throwIfAborted();
            const active = await ensureActivation();
            combined.throwIfAborted();
            const prepared = await this.#broker.prepareInputImages(
              active.activationId,
              toolAssignment,
              sources,
              combined,
            );
            const images = await this.#decodeInputImages(
              prepared.map((item) => item.image),
              { tenantId: command.payload.tenantId, runId: command.payload.runId },
              combined,
            );
            combined.throwIfAborted();
            await recordPreparedInput?.();
            return {
              images,
              hints: prepared.flatMap((item, index) =>
                item.hints.map((hint) => `Image ${index + 1}: ${hint}`),
              ),
            };
          })();
          inputPreparations.add(preparing);
          void preparing.then(
            () => inputPreparations.delete(preparing),
            () => inputPreparations.delete(preparing),
          );
          return preparing;
        },
        ...(this.#acquireModelPermit
          ? {
              acquireModelPermit: (signal?: AbortSignal) =>
                this.#acquireModelPermit!(command, signal),
            }
          : {}),
        ...commonRunnerOptions,
        interruptionReason: () => interruptionReasonForFailureCode(toolRuntimeFailure?.code),
        onToolResultUnavailable: (error) => {
          // The executor already replied. Stop this Run without diagnosing a
          // dead sandbox or requesting cleanup for a completed operation.
          toolRuntimeFailure ??= new PiTurnError(error.code, error.message, false);
        },
        createAgentTools: ({ stepWorldState, captureSamplingStep }) => {
          recordPreparedInput = () => stepWorldState.recordActive(activation);
          const remoteTools = createTrustedRemoteAgentTools({
            onToolCancellationUnconfirmed: () => {
              cancelOutstanding = true;
            },
            observeToolDuration: (seconds, outcome) =>
              this.#metrics?.toolDuration.observe({ tool: "tool.execute", outcome }, seconds),
            supportsImages: modelRuntimeLease.runtime.inputModalities.includes("image"),
            ...(this.#confirmExecution
              ? {
                  confirmExecution: async (bindingId: string, toolSignal: AbortSignal) => {
                    if (
                      !activeSession ||
                      toolRuntimeFailure ||
                      activation?.activationId !== bindingId
                    )
                      return false;
                    const active = AbortSignal.any([
                      signal,
                      toolSignal,
                      activeSession.authority.signal,
                    ]);
                    active.throwIfAborted();
                    await activeSession.authority.assertCurrent();
                    const ready = await this.#confirmExecution!(command, bindingId, active);
                    active.throwIfAborted();
                    await activeSession.authority.assertCurrent();
                    return ready && !toolRuntimeFailure && activation?.activationId === bindingId;
                  },
                }
              : {}),
            ...(this.#waitForToolReply
              ? {
                  waitForToolReply: (request, signal, toolCallId) =>
                    this.#waitForToolReply!(request, signal, toolCallId, {
                      tenantId: command.payload.tenantId,
                      runId: command.payload.runId,
                    }),
                }
              : {}),
            resolveOperationTarget: async () => {
              const active = await ensureActivation();
              return {
                activationId: active.activationId,
                workflowUrl: this.#broker.workflowUrlFor(active.activationId),
              };
            },
            executionReference: toolAssignment.executionReference,
            turnContextSha256: cloudTurn.sha256,
            executionContextSha256: cloudExecution.sha256,
            allowedTools: cloudTurn.context.tools.names,
            captureStepContext: (activeTools, purpose = "agent") =>
              captureSamplingStep(
                async (sequence) => {
                  if (toolRuntimeFailure !== undefined) throw toolRuntimeFailure;
                  const captured = await stepWorldState.capture();
                  const step = createCloudStepContext({
                    sequence,
                    turnContextSha256: cloudTurn.sha256,
                    executionContextSha256: cloudExecution.sha256,
                    allowedTools: cloudTurn.context.tools.names,
                    activeTools,
                    worldState: captured.worldState,
                  });
                  return { step, modelMessages: captured.modelMessages };
                },
                { publishEvent: purpose === "agent" },
              ),
            onToolOperationStarted: () => stepWorldState.recordActive(activation),
            onToolOperationUnavailable: async (failure) => {
              cancelOutstanding = true;
              toolRuntimeFailure ??= new PiTurnError(failure.code, failure.message, false);
              await stepWorldState.recordUnavailable();
            },
            remainingToolCalls: command.payload.budgets?.remainingToolCalls ?? null,
            maximumToolOutputBytes: command.payload.budgets?.maximumToolOutputBytes ?? 65_536,
            workingDirectory: command.payload.workingDirectory,
            ...(downstreamTrace === undefined
              ? {}
              : {
                  traceparent: downstreamTrace.traceparent,
                  ...(downstreamTrace.tracestate === undefined
                    ? {}
                    : { tracestate: downstreamTrace.tracestate }),
                }),
          });
          prepareWorkflow = remoteTools.prepareWorkflow;
          if (trustedTools.length === 0) return remoteTools;
          return {
            ...remoteTools,
            tools: [...remoteTools.tools, ...trustedTools],
            async systemPrompt(base: string) {
              return [await remoteTools.systemPrompt(base)]
                .concat(
                  hasDelegationTool
                    ? [
                        "You may delegate substantial independent work through the subagent Tool. " +
                          "Use stable workflow keys and inspect every returned result. " +
                          "When a Child pauses for input, answer it through subagent_supervisor.",
                      ]
                    : [],
                  hasSupervisorContact
                    ? [
                        "A durable contact_supervisor Tool can reach the parent Agent on this Session's owning Worker.",
                      ]
                    : [],
                )
                .join("\n");
            },
          };
        },
        ...(settlementPolicy ? { settlementPolicy } : {}),
      });
      onPiRunnerReady(runner);
      const result = await runner.run(command, publishEvent, signal);
      return result;
    } catch (error) {
      // Preserve native cancellation and lost write authority even if a Tool
      // diagnostic was recorded first. Otherwise a secondary sampling failure
      // should retain the original, more precise Tool failure.
      const nativeTermination =
        error instanceof PiTurnError &&
        [
          "turn_cancelled",
          "worker_shutdown",
          "session_lease_revoked",
          "writer_publication_failed",
        ].includes(error.code);
      executionError = nativeTermination ? error : (toolRuntimeFailure ?? error);
      throw executionError;
    } finally {
      // A steer can still be preparing pixels when the native operation closes.
      // Join its reservation before deciding which Cube binding to release.
      modelGrant.abort();
      detachModelOwner?.();
      let cleanupError: unknown;
      await releaseModelRuntimeLease(modelRuntimeLease).catch((error: unknown) => {
        cleanupError = error;
      });
      inputPreparationAbort.abort(
        new PiTurnError(
          "steer_target_unavailable",
          "Pi Run ended before input image preparation",
          false,
        ),
      );
      await Promise.allSettled([...inputPreparations]);
      try {
        this.#onRuntimeBinding?.(
          command.payload.executionReference,
          undefined,
          command.payload.piSession.conversationId,
        );
      } catch {
        /* Observation only. */
      }
      if (activation !== undefined) {
        // Tool callbacks have settled or recorded UNKNOWN. Preserve unconfirmed
        // cleanup intent when retiring metadata; VM lifetime remains separate.
        await this.#broker
          .release(activation.activationId, toolAssignment, {
            ...(cancelOutstanding ? { cancelOutstanding: true } : {}),
            kind:
              command.payload.executionMode === "development_environment" &&
              command.payload.computeSessionId === undefined
                ? "detach"
                : "keep_warm",
          })
          .catch((error: unknown) => {
            cleanupError = error;
          });
      }
      if (cleanupError !== undefined && executionError !== undefined) {
        operationalLog({
          service: "pi-cloud-trusted-runner",
          level: "warn",
          event: "run.cleanup_failed_after_execution_error",
        });
      } else if (cleanupError !== undefined) {
        throw safePiError(
          cleanupError,
          "trusted_runner_cleanup_failed",
          "Trusted Agent Runner cleanup could not be confirmed",
        );
      }
    }
  }
}
import type { NativeInputCommand, NativeInputResult } from "@pi-cloud/protocol";
