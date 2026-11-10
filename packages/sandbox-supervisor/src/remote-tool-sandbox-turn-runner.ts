import { measureRunPreparation } from "@pi-cloud/observability";
import { hasConversationWorkspace } from "@pi-cloud/protocol";
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
  type ToolEnvironmentRequest,
  type ExecutionEvidence,
  type ConversationWorkView,
  type ConversationStartRequest,
} from "@pi-cloud/protocol";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  TrustedAgentTool,
  TrustedAgentToolSet,
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
  recoverEnvironment?(
    environment: ToolEnvironmentRequest,
    signal: AbortSignal,
  ): Promise<ExecutionEvidence>;
  prepareEnvironmentImages?(
    environment: ToolEnvironmentRequest,
    images: import("@pi-cloud/protocol").ImageAttachmentReference[],
    signal?: AbortSignal,
  ): Promise<import("@pi-cloud/protocol").EnvironmentImagesResponse>;
  workflowUrlFor(bindingId: string): string;
}

export type RemoteToolSandboxTurnRunnerOptions = {
  publicEgress?: () => import("@pi-cloud/protocol").GuestPublicEgress;
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
    parent?: import("@pi-cloud/protocol").RunActivityParent,
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
      environment(): ToolEnvironmentRequest;
      onExecutionUnavailable(failure: { code: string; message: string }): void;
    }>,
  ) => Promise<TrustedAgentToolSet> | TrustedAgentToolSet;
  acquireModelPermit?: (
    command: ExecuteTurnCommandMessage,
    signal?: AbortSignal,
  ) => Promise<() => void>;
  modelEventIdleTimeoutMs?: number;
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
  readonly #environmentChanges = new Map<
    string,
    (change: import("@pi-cloud/protocol").EnvironmentChanged) => Promise<void>
  >();
  environmentChanged(
    change: import("@pi-cloud/protocol").EnvironmentChanged,
  ): Promise<void> | undefined {
    return this.#environmentChanges
      .get(change.bindingId)?.(change)
      .catch(() => {
        operationalLog({
          service: "pi-cloud-worker",
          level: "warn",
          event: "environment.observation_deferred",
        });
      });
  }
  readonly #environmentObservers = new Map<string, (evidence: ExecutionEvidence) => void>();
  observeExecution(evidence: ExecutionEvidence): void {
    this.#environmentObservers.get(evidence.bindingId)?.(evidence);
  }

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
  readonly #openAgentSession: RemoteToolSandboxTurnRunnerOptions["openAgentSession"];
  readonly #waitForToolReply: RemoteToolSandboxTurnRunnerOptions["waitForToolReply"];
  readonly #confirmExecution: RemoteToolSandboxTurnRunnerOptions["confirmExecution"];
  readonly #decodeInputImages: RemoteToolSandboxTurnRunnerOptions["decodeInputImages"];
  readonly #createTrustedTools: RemoteToolSandboxTurnRunnerOptions["createTrustedTools"];
  readonly #acquireModelPermit: RemoteToolSandboxTurnRunnerOptions["acquireModelPermit"];
  readonly #onActivity: RemoteToolSandboxTurnRunnerOptions["onActivity"];
  readonly #publicEgress: RemoteToolSandboxTurnRunnerOptions["publicEgress"];
  readonly #onRuntimeBinding: RemoteToolSandboxTurnRunnerOptions["onRuntimeBinding"];
  readonly #modelEventIdleTimeoutMs: number | undefined;
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
    this.#publicEgress = options.publicEgress;
    this.#onRuntimeBinding = options.onRuntimeBinding;
    this.#broker = options.broker;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#openAgentSession = options.openAgentSession;
    this.#waitForToolReply = options.waitForToolReply;
    this.#confirmExecution = options.confirmExecution;
    this.#decodeInputImages = options.decodeInputImages;
    this.#createTrustedTools = options.createTrustedTools;
    this.#acquireModelPermit = options.acquireModelPermit;
    this.#modelEventIdleTimeoutMs = options.modelEventIdleTimeoutMs;
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
      const {
        computeSessionId: _compute,
        scheduledOrigin: _scheduled,
        ...rootPayload
      } = family.command.payload;
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
          executionTargets: [],
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
  async #rootRunner(
    command: Pick<NativeInputCommand, "tenantId" | "sessionId" | "runId" | "executionReference">,
  ): Promise<PiCloudTurnRunner> {
    const root = this.#families.get(command.executionReference)?.command.payload;
    if (
      !root ||
      root.tenantId !== command.tenantId ||
      root.sessionId !== command.sessionId ||
      root.runId !== command.runId
    )
      throw new PiTurnError(
        "input_target_unavailable",
        "Input target has no current Worker execution",
        true,
      );
    // A writable conversation can move to a native fork; its ID is not always 1.
    const key = `${command.runId}:${root.piSession.conversationId}`;
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
    return runner;
  }
  async compact(command: NativeCompactCommand): Promise<NativeCompactResult> {
    return (await this.#rootRunner(command)).compact(command);
  }
  async humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
    return (await this.#rootRunner(command)).humanInput(command);
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

    const workspaceAvailable = hasConversationWorkspace(command.payload);
    const cloudTurn = createCloudTurnContext(command);

    const modelGrant = new AbortController();
    const modelGrantSignal = signal
      ? AbortSignal.any([signal, modelGrant.signal])
      : modelGrant.signal;
    const modelRuntimeLease = await measureRunPreparation(
      command.payload.runId,
      "model_grant",
      this.#metrics,
      async () => this.#modelRuntimeLeaseResolver(command, modelGrantSignal),
      {
        signal: modelGrantSignal,
        details: { conversationId: command.payload.piSession.conversationId },
      },
    );
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
    let environment: ToolEnvironmentRequest = {
      toolBrokerProtocolVersion: 1,
      type: "tool_environment",
      piSessionId: command.payload.piSession.id,
      conversationId: command.payload.piSession.conversationId,
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
      workspaceSeedKind: command.payload.workspaceSeedKind,
    };
    const inputPreparationAbort = new AbortController();
    const inputPreparations = new Set<Promise<unknown>>();
    let executionError: unknown;
    let toolRuntimeFailure: PiTurnError | undefined;
    let continuity: { continuityId: string; continuity: "cold_restore" | "warm_reuse" } | undefined;
    let recordContinuity: (() => Promise<void>) | undefined;
    let recordEnvironment: ((evidence: ExecutionEvidence) => Promise<void>) | undefined;
    let invalidateEnvironment: (() => Promise<void>) | undefined;
    const environmentChanged = async (change: import("@pi-cloud/protocol").EnvironmentChanged) => {
      const current = parseExecutionReference(command.payload.executionReference);
      if (
        change.bindingId !== environment.requestId ||
        change.scope.tenantId !== command.payload.tenantId ||
        change.scope.piSessionId !== command.payload.piSession.id ||
        change.scope.runId !== current.runId ||
        change.scope.writerId !== current.leaseId ||
        change.scope.fencingToken !== current.fencingToken ||
        signal.aborted
      )
        return;
      await invalidateEnvironment?.();
    };
    this.#environmentChanges.set(environment.requestId, environmentChanged);
    const noteEnvironment = () => {
      if (!workspaceAvailable)
        throw new PiTurnError(
          "workspace_unavailable",
          "This conversation has no Linux workspace access",
          false,
        );
      signal.throwIfAborted();
      if (toolRuntimeFailure) throw toolRuntimeFailure;
      this.#onRuntimeBinding?.(
        command.payload.executionReference,
        environment.requestId,
        command.payload.piSession.conversationId,
      );
      return environment;
    };
    const observeEnvironment = (evidence: ExecutionEvidence) => {
      if (!evidence.continuityId || !evidence.continuity) return;
      continuity = { continuityId: evidence.continuityId, continuity: evidence.continuity };
      void recordContinuity?.();
    };
    this.#environmentObservers.set(environment.requestId, observeEnvironment);

    try {
      // Worker describes a logical environment. The partition owner prepares it
      // after accepting the durable Tool intent; pure chat creates no binding.

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
      const trustedToolBindings = (await this.#createTrustedTools?.(command, {
        prepareWorkflow: (...args) => {
          if (!prepareWorkflow) throw new Error("Remote workflow runtime is not ready");
          return prepareWorkflow(...args);
        },
        environment: noteEnvironment,
        onExecutionUnavailable: (failure) => {
          toolRuntimeFailure ??= new PiTurnError(failure.code, failure.message, false);
        },
      })) ?? { current: () => [] as readonly TrustedAgentTool[], subscribe: () => () => {} };
      const trustedTools = () =>
        trustedToolBindings
          .current()
          .filter((binding) => binding.offered !== false)
          .map((binding) => binding.tool);
      const hasSupervisorContact = trustedTools().some(
        (tool) => tool.name === "contact_supervisor",
      );
      let activeSession: PiCloudSessionHandle | undefined;
      const childView = command.payload.conversationWork;
      const parentFamily = childView
        ? this.#families.get(command.payload.executionReference)
        : undefined;
      const parentView =
        childView?.parentConversationId === 1
          ? parentFamily?.command.payload
          : [...(parentFamily?.children.values() ?? [])].find(
              (child) => child.conversationId === childView?.parentConversationId,
            )?.view;
      const activityParent =
        childView && parentView
          ? {
              sessionId: parentView.sessionId,
              turnId: parentView.turnId,
              toolCallId: `task:${childView.ownerTaskId}`,
            }
          : undefined;
      const commonRunnerOptions = {
        ...(this.#publicEgress ? { publicEgress: this.#publicEgress } : {}),
        trustedToolDefinitions: {
          current: () => trustedToolBindings.current().map((binding) => binding.tool),
          subscribe: trustedToolBindings.subscribe,
        },
        onActivity: (update: import("@pi-cloud/protocol").RunActivityUpdate | undefined) =>
          this.#onActivity?.(command, update, activityParent),
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
          writerId: parseExecutionReference(command.payload.executionReference).leaseId,
          continuityId:
            continuity?.continuityId ??
            parseExecutionReference(command.payload.executionReference).runId,
          continuity: continuity?.continuity ?? "cold_restore",
          environmentSha256: cloudTurn.environmentSha256,
          workspaceBindingSha256: cloudTurn.workspaceBindingSha256,
          toolPolicySha256: cloudTurn.toolPolicySha256,
        },
        onSettled,
        ...(this.#modelEventIdleTimeoutMs === undefined
          ? {
              modelEventIdleTimeoutMs: modelRuntimeLease.runtime.eventIdleTimeoutMs,
            }
          : { modelEventIdleTimeoutMs: this.#modelEventIdleTimeoutMs }),
      };
      const runner = new PiCloudTurnRunner({
        beforeEffect: async (effectSignal) => {
          if (toolRuntimeFailure) throw toolRuntimeFailure;
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
              !this.#broker.prepareEnvironmentImages ||
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
            const prepared = await this.#broker.prepareEnvironmentImages(
              noteEnvironment(),
              sources,
              combined,
            );
            const images = await this.#decodeInputImages(
              prepared.images.map((item) => item.image),
              { tenantId: command.payload.tenantId, runId: command.payload.runId },
              combined,
            );
            combined.throwIfAborted();
            this.observeExecution(prepared.execution);
            await recordContinuity?.();
            await recordEnvironment?.(prepared.execution);
            return {
              images,
              hints: prepared.images.flatMap((item, index) =>
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
          recordEnvironment = (evidence) =>
            stepWorldState.recordExecution(command.payload.runId, evidence);
          invalidateEnvironment = () =>
            stepWorldState.requireRecovery(
              command.payload.runId,
              environment.requestId,
              "environment_binding_closed",
            );
          recordContinuity = () => stepWorldState.recordActive(continuity);
          let recovering: Promise<void> | undefined;
          const ensureRecovered = () => {
            const work = async () => {
              let pending = await stepWorldState.pendingRecovery(command.payload.runId);
              if (!pending) return;
              if (!this.#broker.recoverEnvironment)
                throw new Error("Environment recovery is not configured");
              const active = AbortSignal.any([signal, activeSession!.authority.signal]);
              const renewLogicalBinding = () => {
                this.#environmentObservers.delete(environment.requestId);
                this.#environmentChanges.delete(environment.requestId);
                environment = { ...environment, requestId: this.#idGenerator() };
                this.#environmentObservers.set(environment.requestId, observeEnvironment);
                this.#environmentChanges.set(environment.requestId, environmentChanged);
              };
              // A failed environment may already have lost its closed PG row.
              // Start recovery with a new logical address once; retries retain
              // that address. Existing operations keep their original targets.
              for (;;) {
                active.throwIfAborted();
                pending = await stepWorldState.pendingRecovery(command.payload.runId);
                if (!pending) return;
                if (pending.bindingId === environment.requestId) renewLogicalBinding();
                this.#onActivity?.(
                  command,
                  { phase: "waiting_environment", lastActivityAt: Date.now() },
                  activityParent,
                );
                await activeSession!.authority.assertCurrent();
                try {
                  const evidence = await this.#broker.recoverEnvironment(environment, active);
                  active.throwIfAborted();
                  await activeSession!.authority.assertCurrent();
                  this.#onRuntimeBinding?.(
                    command.payload.executionReference,
                    environment.requestId,
                    command.payload.piSession.conversationId,
                  );
                  if (
                    !evidence.continuityId ||
                    !this.#confirmExecution ||
                    !(await this.#confirmExecution(command, environment.requestId, active))
                  )
                    throw new PiTurnError(
                      "tool_environment_pending",
                      "Waiting for the restored execution reply path",
                      true,
                    );
                  observeEnvironment(evidence);
                  await stepWorldState.completeRecovery(
                    command.payload.runId,
                    {
                      continuityId: evidence.continuityId!,
                      continuity: evidence.continuity ?? "cold_restore",
                    },
                    pending.previousContinuityId,
                    pending.revision,
                  );
                  return;
                } catch (error) {
                  active.throwIfAborted();
                  const failure = error as { code?: string; retryable?: boolean };
                  if (failure.code === "tool_binding_closed") renewLogicalBinding();
                  else if (failure.retryable !== true) throw error;
                  operationalLog({
                    service: "pi-cloud-worker",
                    level: "info",
                    event: "environment.recovery_wait",
                    attributes: {
                      runId: command.payload.runId,
                      code: failure.code ?? "unavailable",
                    },
                  });
                  await delay(5000, undefined, { signal: active });
                }
              }
            };
            return (recovering ??= work().finally(() => {
              recovering = undefined;
            }));
          };
          const remoteTools = createTrustedRemoteAgentTools({
            recordExecution: (evidence, originalWriterId) =>
              stepWorldState.recordExecution(command.payload.runId, evidence, originalWriterId),
            observeToolDuration: (seconds, outcome) =>
              this.#metrics?.toolDuration.observe({ tool: "tool.execute", outcome }, seconds),
            supportsImages: modelRuntimeLease.runtime.inputModalities.includes("image"),
            ...(this.#confirmExecution
              ? {
                  confirmExecution: async (bindingId: string, toolSignal: AbortSignal) => {
                    if (!activeSession || toolRuntimeFailure || environment.requestId !== bindingId)
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
                    return ready && !toolRuntimeFailure && environment.requestId === bindingId;
                  },
                }
              : {}),
            ...(this.#waitForToolReply
              ? {
                  waitForToolReply: (request, signal, toolCallId, _scope, recovery) =>
                    this.#waitForToolReply!(
                      request,
                      signal,
                      toolCallId,
                      {
                        tenantId: command.payload.tenantId,
                        runId: command.payload.runId,
                      },
                      recovery,
                    ),
                }
              : {}),
            resolveOperationTarget: async () => {
              const logical = noteEnvironment();
              return {
                activationId: logical.requestId,
                environment: logical,
                workflowUrl: this.#broker.workflowUrlFor(logical.requestId),
              };
            },
            executionReference: toolAssignment.executionReference,
            workspaceAvailable,
            turnContextSha256: cloudTurn.sha256,
            executionContextSha256: cloudExecution.sha256,
            allowedTools: cloudTurn.context.tools.names,
            captureStepContext: (activeTools, purpose = "agent") =>
              captureSamplingStep(
                async (sequence) => {
                  if (toolRuntimeFailure !== undefined) throw toolRuntimeFailure;
                  if (purpose === "agent") await ensureRecovered();
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
            onToolOperationUnavailable: async (failure) => {
              await stepWorldState.requireRecovery(
                command.payload.runId,
                environment.requestId,
                failure.code,
              );
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
          return {
            ...remoteTools,
            get tools() {
              return [...remoteTools.tools, ...trustedTools()];
            },
            async systemPrompt(base: string) {
              return [await remoteTools.systemPrompt(base)]
                .concat(
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
      // Close preparation waiters. The ordered Session boundary retires bindings;
      // the Worker never releases physical resources.
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
      this.#environmentObservers.delete(environment.requestId);
      this.#environmentChanges.delete(environment.requestId);
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
import type { NativeCompactCommand, NativeCompactResult } from "@pi-cloud/protocol";
