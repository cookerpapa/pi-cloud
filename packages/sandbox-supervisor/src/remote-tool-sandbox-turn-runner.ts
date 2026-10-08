import type { WorkflowExecutor } from "./workflow-transport.ts";
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
  onRuntimeBinding?: (executionReference: string, bindingId: string | undefined) => void;
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
  publishToolCommand?: import("@pi-cloud/protocol").ToolCommandPublisher["publishToolCommand"];
  waitForToolReply?: TrustedRemoteToolsRuntimeConfiguration["waitForToolReply"];
  createTrustedTools?: (
    command: ExecuteTurnCommandMessage,
    context: Readonly<{
      executeWorkflow: WorkflowExecutor;
      refreshServices(): Promise<void>;
    }>,
  ) => Promise<readonly TrustedAgentTool[]> | readonly TrustedAgentTool[];
  acquireModelPermit?: (
    command: ExecuteTurnCommandMessage,
    signal?: AbortSignal,
  ) => Promise<() => void>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
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
  readonly #broker: SandboxControlBoundary;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #trustedWorkspaceDirectory: string;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver;
  readonly #workspaceSeedResolver: AgentWorkspaceSeedResolver | undefined;
  readonly #openAgentSession: RemoteToolSandboxTurnRunnerOptions["openAgentSession"];
  readonly #publishToolCommand: RemoteToolSandboxTurnRunnerOptions["publishToolCommand"];
  readonly #waitForToolReply: RemoteToolSandboxTurnRunnerOptions["waitForToolReply"];
  readonly #decodeInputImages: RemoteToolSandboxTurnRunnerOptions["decodeInputImages"];
  readonly #createTrustedTools: RemoteToolSandboxTurnRunnerOptions["createTrustedTools"];
  readonly #acquireModelPermit: RemoteToolSandboxTurnRunnerOptions["acquireModelPermit"];
  readonly #onActivity: RemoteToolSandboxTurnRunnerOptions["onActivity"];
  readonly #onRuntimeBinding: RemoteToolSandboxTurnRunnerOptions["onRuntimeBinding"];
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
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
    this.#onActivity = options.onActivity;
    this.#onRuntimeBinding = options.onRuntimeBinding;
    this.#broker = options.broker;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#openAgentSession = options.openAgentSession;
    this.#publishToolCommand = options.publishToolCommand;
    this.#waitForToolReply = options.waitForToolReply;
    this.#decodeInputImages = options.decodeInputImages;
    this.#createTrustedTools = options.createTrustedTools;
    this.#acquireModelPermit = options.acquireModelPermit;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
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
    if (this.#activePiRunners.has(command.payload.runId)) {
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
    this.#activePiRunners.set(command.payload.runId, slot);
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
      if (this.#activePiRunners.get(command.payload.runId) === slot) {
        this.#activePiRunners.delete(command.payload.runId);
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
  async agentInput(
    runId: string,
    id: string,
    text: string,
    delivery: "notify" | "steer" | "follow_up",
    executionReference: string,
  ): Promise<void> {
    const slot = this.#activePiRunners.get(runId);
    if (!slot) throw new Error("Target Agent is not running on this Worker");
    if (slot.executionReference !== executionReference)
      throw new Error("Target Agent input authority mismatch");
    const runner = await slot.ready;
    if (this.#activePiRunners.get(runId) !== slot)
      throw new Error("Target Agent ended before input delivery");
    await runner.agentInput(id, text, delivery);
  }
  async humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
    const slot = this.#activePiRunners.get(command.runId);
    if (!slot || slot.executionReference !== command.executionReference)
      throw new PiTurnError(
        "input_target_unavailable",
        "Input target has no current Worker execution",
        true,
      );
    const runner = await slot.ready;
    if (this.#activePiRunners.get(command.runId) !== slot)
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
        workspaceSeed = await this.#workspaceSeedResolver(command, signal);
      } catch (error: unknown) {
        throw safePiError(
          error,
          "workspace_seed_unavailable",
          "Workspace source could not be provisioned",
        );
      }
    }
    const cloudTurn = createCloudTurnContext(command);

    const modelRuntimeLease = await this.#modelRuntimeLeaseResolver(command);
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
            this.#onRuntimeBinding?.(command.payload.executionReference, created.activationId);
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
      let executeWorkflow: WorkflowExecutor | undefined;
      const trustedToolBindings =
        (await this.#createTrustedTools?.(command, {
          executeWorkflow: (...args) => {
            if (!executeWorkflow) throw new Error("Remote workflow runtime is not ready");
            return executeWorkflow(...args);
          },
          refreshServices: async () => {
            const active = await ensureActivation();
            await this.#broker.refreshServices(active.activationId, toolAssignment);
          },
        })) ?? ([] as readonly TrustedAgentTool[]);
      const trustedTools = trustedToolBindings
        .filter((binding) => binding.offered !== false)
        .map((binding) => binding.tool);
      const hasDelegationTool = trustedTools.some((tool) => tool.name === "subagent");
      const hasSupervisorContact = trustedTools.some((tool) => tool.name === "contact_supervisor");
      const commonRunnerOptions = {
        trustedToolDefinitions: trustedToolBindings.map((binding) => binding.tool),
        onActivity: (update: import("@pi-cloud/protocol").RunActivityUpdate | undefined) =>
          this.#onActivity?.(command, update),
        resolveModelRuntime,
        openSession: this.#openAgentSession,
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
        ...(modelRuntimeLease.subscribeHostedActivity === undefined
          ? {}
          : { subscribeHostedActivity: modelRuntimeLease.subscribeHostedActivity }),
        ...(modelRuntimeLease.subscribeHostedTranscript === undefined
          ? {}
          : { subscribeHostedTranscript: modelRuntimeLease.subscribeHostedTranscript }),
        ...(this.#requestTimeoutMs === undefined
          ? {
              requestTimeoutMs: modelRuntimeLease.runtime.requestTimeoutMs,
            }
          : { requestTimeoutMs: this.#requestTimeoutMs }),
        ...(this.#turnTimeoutMs === undefined
          ? {
              turnTimeoutMs: Math.min(
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
                modelRuntimeLease.runtime.turnTimeoutMs,
              ),
            }
          : {
              turnTimeoutMs: Math.min(
                this.#turnTimeoutMs,
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
              ),
            }),
      };
      let recordPreparedInput: (() => Promise<void>) | undefined;
      const runner = new PiCloudTurnRunner({
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
        ...(modelRuntimeLease.resolveAssistantTextPhase === undefined
          ? {}
          : {
              resolveAssistantTextPhase: modelRuntimeLease.resolveAssistantTextPhase,
            }),
        ...(this.#acquireModelPermit
          ? {
              acquireModelPermit: (signal?: AbortSignal) =>
                this.#acquireModelPermit!(command, signal),
            }
          : {}),
        ...commonRunnerOptions,
        interruptionReason: () => interruptionReasonForFailureCode(toolRuntimeFailure?.code),
        createAgentTools: ({ stepWorldState, captureSamplingStep, trackWorkflowOperation }) => {
          recordPreparedInput = () => stepWorldState.recordActive(activation);
          const remoteTools = createTrustedRemoteAgentTools({
            trackWorkflowOperation,
            onToolCancellationUnconfirmed: () => {
              cancelOutstanding = true;
            },
            observeToolDuration: (seconds, outcome) =>
              this.#metrics?.toolDuration.observe({ tool: "tool.execute", outcome }, seconds),
            supportsImages: modelRuntimeLease.runtime.inputModalities.includes("image"),
            ...(this.#waitForToolReply
              ? {
                  waitForToolReply: (request, signal, toolCallId) =>
                    this.#waitForToolReply!(request, signal, toolCallId, {
                      tenantId: command.payload.tenantId,
                      runId: command.payload.runId,
                    }),
                }
              : {}),
            publishToolCommand: (command) => {
              if (!this.#publishToolCommand)
                throw new Error("Tool command publisher is unavailable");
              return this.#publishToolCommand(command);
            },
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
          executeWorkflow = remoteTools.executeWorkflow;
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
      // Pi may surface a secondary sampling/settlement error while unwinding
      // after a refused next Step. The first Tool transport failure is primary.
      executionError = toolRuntimeFailure ?? error;
      throw executionError;
    } finally {
      // A steer can still be preparing pixels when the native operation closes.
      // Join its reservation before deciding which Cube binding to release.
      inputPreparationAbort.abort(
        new PiTurnError(
          "steer_target_unavailable",
          "Pi Run ended before input image preparation",
          false,
        ),
      );
      await Promise.allSettled([...inputPreparations]);
      try {
        this.#onRuntimeBinding?.(command.payload.executionReference, undefined);
      } catch {
        /* Observation only. */
      }
      let cleanupError: unknown;
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
      await releaseModelRuntimeLease(modelRuntimeLease).catch((error: unknown) => {
        cleanupError ??= error;
      });
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
