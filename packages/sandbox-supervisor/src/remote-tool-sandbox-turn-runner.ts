import { FAKE_MODEL_API_KEY, FakeModelServer } from "@pi-cloud/fake-model-server";
import { activeTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import {
  type ExecuteTurnCommandMessage,
  modelSamplingHeaders,
  parseExecutionLease,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
} from "@pi-cloud/protocol";
import {
  decodeWorkspaceBlob,
  encodeWorkspaceBlob,
  parseWorkspaceVolumeSettlement,
  parseWorkspaceSeed,
} from "@pi-cloud/workspace-runtime";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SupervisorTurnRunner } from "./agent-run-supervisor.ts";
import { PiTurnError, type PiEventPublisher, type PiTurnResult } from "./pi-turn-runtime.ts";
import {
  PiCloudTurnRunner,
  PiModelRuntimePool,
  type PiCloudSessionHandle,
  type PiCloudTurnRunnerOptions,
} from "./pi-cloud-turn-runner.ts";
import {
  PiSettlementGateController,
  settlementGatePolicyFromCommand,
} from "./pi-settlement-gate.ts";
import {
  validateLoadedWorkspaceSettlement,
  type LoadedWorkspaceSettlement,
  type WorkspaceSettlementStore,
} from "./workspace-settlement.ts";
import {
  validateSandboxRuntimeIdentity,
  type SandboxRuntimeIdentity,
} from "./sandbox-assignment-inventory.ts";
import type {
  AgentTurnScenario,
  AgentTurnScenarioResolver,
  AgentWorkspaceSeedResolver,
  TrustedAgentTool,
  TrustedModelRuntimeLease,
  TrustedModelRuntimeLeaseResolver,
} from "./agent-turn-runtime.ts";
import type { RunAttemptPhaseObserver } from "./run-attempt-phase.ts";
import { createTrustedRemoteAgentTools } from "./trusted-remote-tools-extension.ts";
import {
  createCloudAttemptContext,
  createCloudStepContext,
  createCloudTurnContext,
} from "./cloud-context.ts";

const MAX_PROJECT_INSTRUCTIONS_BYTES = 16 * 1_024;

export function projectInstructionsFromWorkspaceSeed(
  seed: Uint8Array | undefined,
): string | undefined {
  if (seed === undefined) return undefined;
  if (parseWorkspaceVolumeSettlement(seed) !== undefined) {
    // The persistent-volume reference contains no file bytes. The trusted
    // Runner reads project instructions only after the Volume is attached
    // through the Tool boundary.
    return undefined;
  }
  const file = parseWorkspaceSeed(seed).find((entry) => entry.path === "AGENTS.md");
  if (file === undefined) return undefined;
  const bounded = file.content.subarray(0, MAX_PROJECT_INSTRUCTIONS_BYTES);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bounded);
  } catch {
    return undefined;
  }
  if (content.includes("\0") || content.trim().length === 0) return undefined;
  return `${content}${file.content.byteLength > bounded.byteLength ? "\n[AGENTS.md truncated by PiCloud]" : ""}`;
}

export interface ToolBrokerBoundary {
  create(request: ToolSandboxCreateRequest): Promise<ToolSandboxCreateResponse>;
  capture(
    activationId: string,
    assignment: ToolSandboxAssignment,
  ): Promise<ToolSandboxCaptureResponse>;
  release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition: { kind: "keep_warm"; workspaceRevision: string } | { kind: "destroy" },
  ): Promise<{ retained: boolean }>;
  stop(activationId: string, assignment: ToolSandboxAssignment): Promise<void>;
  operationUrlFor(activationId: string): string;
}

export type RemoteToolSandboxTurnRunnerOptions = {
  broker: ToolBrokerBoundary;
  runtimeIdentity: SandboxRuntimeIdentity;
  trustedWorkspaceDirectory: string;
  scenario?: AgentTurnScenario | AgentTurnScenarioResolver;
  modelRuntimeLeaseResolver?: TrustedModelRuntimeLeaseResolver;
  workspaceSeedResolver?: AgentWorkspaceSeedResolver;
  settlementStore?: WorkspaceSettlementStore;
  openAgentSession: (command: ExecuteTurnCommandMessage) => Promise<PiCloudSessionHandle>;
  createTrustedTools?: (
    command: ExecuteTurnCommandMessage,
    context: Readonly<{
      activation?: Readonly<{ activationId: string; assignment: ToolSandboxAssignment }>;
    }>,
  ) => Promise<readonly TrustedAgentTool[]> | readonly TrustedAgentTool[];
  runAttemptPhaseObserver?: RunAttemptPhaseObserver;
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
    executionLease: command.payload.executionLease,
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

async function releaseModelRuntimeLease(
  lease: TrustedModelRuntimeLease | undefined,
): Promise<void> {
  if (lease !== undefined) await lease.release();
}

export class RemoteToolSandboxTurnRunner implements SupervisorTurnRunner {
  readonly #broker: ToolBrokerBoundary;
  readonly #runtimeIdentity: SandboxRuntimeIdentity;
  readonly #trustedWorkspaceDirectory: string;
  readonly #scenario: AgentTurnScenario | AgentTurnScenarioResolver;
  readonly #modelRuntimeLeaseResolver: TrustedModelRuntimeLeaseResolver | undefined;
  readonly #workspaceSeedResolver: AgentWorkspaceSeedResolver | undefined;
  readonly #settlementStore: WorkspaceSettlementStore | undefined;
  readonly #openAgentSession: RemoteToolSandboxTurnRunnerOptions["openAgentSession"];
  readonly #createTrustedTools: RemoteToolSandboxTurnRunnerOptions["createTrustedTools"];
  readonly #runAttemptPhaseObserver: RunAttemptPhaseObserver | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #idGenerator: () => string;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #modelRuntimePool = new PiModelRuntimePool(2);
  readonly #activePiRunners = new Map<
    string,
    {
      ready: Promise<PiCloudTurnRunner>;
      resolve: (runner: PiCloudTurnRunner) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: RemoteToolSandboxTurnRunnerOptions) {
    this.#broker = options.broker;
    this.#runtimeIdentity = validateSandboxRuntimeIdentity(options.runtimeIdentity);
    this.#trustedWorkspaceDirectory = resolve(options.trustedWorkspaceDirectory);
    this.#scenario = options.scenario ?? "java_repair";
    this.#modelRuntimeLeaseResolver = options.modelRuntimeLeaseResolver;
    this.#workspaceSeedResolver = options.workspaceSeedResolver;
    this.#settlementStore = options.settlementStore;
    this.#openAgentSession = options.openAgentSession;
    this.#createTrustedTools = options.createTrustedTools;
    this.#runAttemptPhaseObserver = options.runAttemptPhaseObserver;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#metrics = options.metrics;
  }

  warm(): Promise<void> {
    return this.#modelRuntimePool.ready();
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
    const slot = { ready, resolve: resolveRunner, reject: rejectRunner };
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
          "pi_cloud.execution.id": parseExecutionLease(command.payload.executionLease).attemptId,
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

  async steer(targetRunId: string, text: string): Promise<void> {
    const slot = this.#activePiRunners.get(targetRunId);
    if (slot === undefined) {
      throw new PiTurnError(
        "steer_target_unavailable",
        "Pi Run is not active on this Worker",
        false,
      );
    }
    const runner = await slot.ready;
    if (this.#activePiRunners.get(targetRunId) !== slot) {
      throw new PiTurnError(
        "steer_target_unavailable",
        "Pi Run ended before the steer could be delivered",
        false,
      );
    }
    await runner.steer(text);
  }

  async #run(
    command: ExecuteTurnCommandMessage,
    publishEvent: PiEventPublisher,
    signal: AbortSignal,
    onPiRunnerReady: (runner: PiCloudTurnRunner) => void,
  ): Promise<PiTurnResult> {
    if (
      command.payload.agent.runtimeKind !== "pi_sdk" ||
      command.payload.agent.sessionStorageKind !== "pi_session_storage_v1"
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

    let loadedSettlement: LoadedWorkspaceSettlement | undefined;
    if (this.#settlementStore !== undefined) {
      const restoreStartedAt = performance.now();
      try {
        loadedSettlement = validateLoadedWorkspaceSettlement(
          await this.#settlementStore.load(command),
        );
        this.#metrics?.workspaceSettlementRestoreDuration.observe(
          { outcome: loadedSettlement === undefined ? "empty" : "completed" },
          (performance.now() - restoreStartedAt) / 1_000,
        );
      } catch (error: unknown) {
        this.#metrics?.workspaceSettlementRestoreDuration.observe(
          { outcome: "failed" },
          (performance.now() - restoreStartedAt) / 1_000,
        );
        throw safePiError(
          error,
          "settlement_load_failed",
          "The Workspace settlement could not be loaded",
        );
      }
    }
    if (loadedSettlement !== undefined && this.#runAttemptPhaseObserver !== undefined) {
      try {
        await this.#runAttemptPhaseObserver.transition(command, "restoring");
      } catch (error: unknown) {
        throw safePiError(
          error,
          "run_phase_persist_failed",
          "Run restore phase could not be persisted",
        );
      }
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
    const projectInstructions = projectInstructionsFromWorkspaceSeed(
      loadedSettlement?.reference ?? workspaceSeed,
    );
    const cloudTurn = createCloudTurnContext(command, loadedSettlement?.workspaceRevision);
    const toolFree = cloudTurn.context.tools.names.length === 0;

    const usesEmbeddedFake =
      command.payload.model.provider === "pi-cloud-fake" &&
      command.payload.model.modelId === "pi-cloud-fake";
    let modelRuntimeLease: TrustedModelRuntimeLease | undefined;
    if (!usesEmbeddedFake) {
      if (this.#modelRuntimeLeaseResolver === undefined) {
        throw new PiTurnError(
          "credential_unavailable",
          "A real model runtime is not configured for this Agent Runner",
          true,
        );
      }
      modelRuntimeLease = await this.#modelRuntimeLeaseResolver(command);
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
    }

    const scenario =
      typeof this.#scenario === "function"
        ? this.#scenario({ command, restoring: loadedSettlement !== undefined })
        : this.#scenario;
    const toolAssignment = assignment(command, this.#runtimeIdentity);
    const cloudAttempt = createCloudAttemptContext({
      command,
      runtimeIdentity: this.#runtimeIdentity,
      turnContextSha256: cloudTurn.sha256,
    });
    let activation: ToolSandboxCreateResponse | undefined;
    let fakeModel: FakeModelServer | undefined;
    let retainedWorkspaceRevision: string | undefined;
    let completedSuccessfully = false;
    let stopPromise: Promise<void> | undefined;
    const stopSandbox = (): Promise<void> => {
      if (activation === undefined) return Promise.resolve();
      if (stopPromise === undefined) {
        const startedAt = performance.now();
        stopPromise = this.#broker.stop(activation.activationId, toolAssignment).then(
          () => {
            this.#metrics?.sandboxDuration.observe(
              { operation: "stop", outcome: "completed" },
              (performance.now() - startedAt) / 1_000,
            );
          },
          (error: unknown) => {
            this.#metrics?.sandboxDuration.observe(
              { operation: "stop", outcome: "failed" },
              (performance.now() - startedAt) / 1_000,
            );
            throw error;
          },
        );
      }
      return stopPromise;
    };
    const abortSandbox = (): void => {
      void stopSandbox().catch(() => undefined);
    };

    try {
      const createRequest: ToolSandboxCreateRequest = {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.create",
        requestId: this.#idGenerator(),
        assignment: toolAssignment,
        turnContextSha256: cloudTurn.sha256,
        attemptContextSha256: cloudAttempt.sha256,
        allowedTools: cloudTurn.context.tools.names,
        executionMode: command.payload.executionMode,
        sandboxProfileKey: command.payload.sandboxProfileKey,
        toolRoot: command.payload.workingDirectory,
        environment: command.payload.environment,
        workspaceSeed:
          workspaceSeed === undefined
            ? { kind: "sample_java" }
            : { kind: "bundle", bundle: encodeWorkspaceBlob(workspaceSeed) },
        ...(loadedSettlement === undefined
          ? {}
          : {
              ...(loadedSettlement.reference === undefined
                ? {}
                : {
                    workspaceSettlement: encodeWorkspaceBlob(loadedSettlement.reference),
                  }),
              ...(loadedSettlement.workspaceRevision === undefined
                ? {}
                : { workspaceRevision: loadedSettlement.workspaceRevision }),
            }),
      };
      if (!toolFree) {
        const createStartedAt = performance.now();
        try {
          activation = await this.#broker.create(createRequest);
          this.#metrics?.sandboxDuration.observe(
            { operation: "reserve", outcome: "completed" },
            (performance.now() - createStartedAt) / 1_000,
          );
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
      }
      signal.addEventListener("abort", abortSandbox, { once: true });
      if (signal.aborted) abortSandbox();

      if (usesEmbeddedFake) {
        fakeModel = new FakeModelServer({ defaultScenario: scenario });
        await fakeModel.start();
      }
      if (this.#runAttemptPhaseObserver !== undefined) {
        try {
          await this.#runAttemptPhaseObserver.transition(command, "running");
        } catch (error: unknown) {
          throw safePiError(
            error,
            "run_phase_persist_failed",
            "Run execution phase could not be persisted",
          );
        }
      }

      const resolveModelRuntime: PiCloudTurnRunnerOptions["resolveModelRuntime"] = (model) =>
        usesEmbeddedFake
          ? {
              provider: model.provider,
              modelId: model.modelId,
              baseUrl: fakeModel!.baseUrl,
              api: "openai-completions",
              apiKey: FAKE_MODEL_API_KEY,
            }
          : {
              provider: modelRuntimeLease!.runtime.provider,
              modelId: modelRuntimeLease!.runtime.modelId,
              baseUrl: modelRuntimeLease!.runtime.baseUrl,
              api: modelRuntimeLease!.runtime.api,
              apiKey: modelRuntimeLease!.runtime.capability,
              ...(modelRuntimeLease!.runtime.api === "openai-codex-responses"
                ? { transport: "sse" as const }
                : {}),
              ...(modelRuntimeLease!.runtime.reasoning === undefined
                ? {}
                : { reasoning: modelRuntimeLease!.runtime.reasoning }),
              ...(modelRuntimeLease!.runtime.contextWindow === undefined
                ? {}
                : { contextWindow: modelRuntimeLease!.runtime.contextWindow }),
              ...(modelRuntimeLease!.runtime.maxTokens === undefined
                ? {}
                : { maxTokens: modelRuntimeLease!.runtime.maxTokens }),
              inputModalities: modelRuntimeLease!.runtime.inputModalities,
              hostedTools: modelRuntimeLease!.runtime.hostedTools,
              serviceTier: modelRuntimeLease!.runtime.serviceTier,
            };
      const onSettled: NonNullable<PiCloudTurnRunnerOptions["onSettled"]> = async () => {
        if (activation === undefined) {
          if (toolFree) {
            retainedWorkspaceRevision = loadedSettlement?.workspaceRevision;
            return;
          }
          throw new PiTurnError(
            "tool_sandbox_unavailable",
            "Tool Sandbox was unavailable at settlement",
            true,
          );
        }
        const settlementStartedAt = performance.now();
        const captured = await this.#broker
          .capture(activation.activationId, toolAssignment)
          .catch((error: unknown) => {
            this.#metrics?.workspaceSettlementDuration.observe(
              { outcome: "failed" },
              (performance.now() - settlementStartedAt) / 1_000,
            );
            throw safePiError(
              error,
              "workspace_settlement_capture_failed",
              "The Tool Workspace settlement could not be captured",
            );
          });
        if (captured.type === "tool_sandbox.unused") {
          retainedWorkspaceRevision = loadedSettlement?.workspaceRevision;
          this.#metrics?.workspaceSettlementDuration.observe(
            { outcome: "completed" },
            (performance.now() - settlementStartedAt) / 1_000,
          );
          return;
        }
        if (this.#runAttemptPhaseObserver !== undefined) {
          try {
            await this.#runAttemptPhaseObserver.transition(command, "settling");
          } catch (error: unknown) {
            throw safePiError(
              error,
              "run_phase_persist_failed",
              "Run settlement phase could not be persisted",
            );
          }
        }
        if (this.#settlementStore !== undefined) {
          try {
            const saved = await this.#settlementStore.save(
              command,
              loadedSettlement?.revision ?? null,
              {
                reference: decodeWorkspaceBlob(captured.settlement),
                environment: captured.environment,
              },
            );
            retainedWorkspaceRevision = saved.workspaceRevision;
            await this.#runAttemptPhaseObserver?.settlementCommitted(command, saved.revision);
            this.#metrics?.workspaceSettlementDuration.observe(
              { outcome: "completed" },
              (performance.now() - settlementStartedAt) / 1_000,
            );
          } catch (error: unknown) {
            this.#metrics?.workspaceSettlementDuration.observe(
              { outcome: "failed" },
              (performance.now() - settlementStartedAt) / 1_000,
            );
            throw safePiError(
              error,
              "settlement_save_failed",
              "The settled settlement could not be committed",
            );
          }
        } else {
          retainedWorkspaceRevision = captured.settlement.sha256;
        }
      };
      const activeSandbox = activation;
      const settlementPolicy = settlementGatePolicyFromCommand(command);
      const settlementGate =
        settlementPolicy === undefined
          ? undefined
          : new PiSettlementGateController(settlementPolicy);
      const trustedToolBindings =
        (await this.#createTrustedTools?.(command, {
          ...(activeSandbox === undefined
            ? {}
            : {
                activation: {
                  activationId: activeSandbox.activationId,
                  assignment: toolAssignment,
                },
              }),
        })) ?? ([] as readonly TrustedAgentTool[]);
      const trustedTools = trustedToolBindings.map((binding) => binding.tool);
      const hasDelegationTool = trustedTools.some((tool) => tool.name === "subagent");
      const hasSupervisorContact = trustedTools.some((tool) => tool.name === "contact_supervisor");
      const commonRunnerOptions = {
        resolveModelRuntime,
        openSession: this.#openAgentSession,
        modelRuntimePool: this.#modelRuntimePool,
        ...(this.#metrics === undefined ? {} : { metrics: this.#metrics }),
        ...(this.#settlementStore?.saveToolOutput === undefined
          ? {}
          : {
              persistToolOutputArtifact: (output: { toolCallId: string; bytes: Uint8Array }) =>
                this.#settlementStore!.saveToolOutput!(command, output),
            }),
        sandboxContinuity: {
          continuityId:
            activeSandbox?.continuityId ??
            parseExecutionLease(command.payload.executionLease).attemptId,
          continuity: activeSandbox?.continuity ?? "cold_restore",
          environmentSha256: cloudTurn.environmentSha256,
          workspaceBindingSha256: cloudTurn.workspaceBindingSha256,
          committedWorkspaceRevision: loadedSettlement?.workspaceRevision ?? null,
          toolPolicySha256: cloudTurn.toolPolicySha256,
        },
        onSettled,
        ...(modelRuntimeLease?.subscribeHostedActivity === undefined
          ? {}
          : { subscribeHostedActivity: modelRuntimeLease.subscribeHostedActivity }),
        ...(modelRuntimeLease?.subscribeHostedTranscript === undefined
          ? {}
          : { subscribeHostedTranscript: modelRuntimeLease.subscribeHostedTranscript }),
        ...(this.#requestTimeoutMs === undefined
          ? {
              requestTimeoutMs: usesEmbeddedFake
                ? 10_000
                : modelRuntimeLease!.runtime.requestTimeoutMs,
            }
          : { requestTimeoutMs: this.#requestTimeoutMs }),
        ...(this.#turnTimeoutMs === undefined
          ? {
              turnTimeoutMs: Math.min(
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
                usesEmbeddedFake ? 60_000 : modelRuntimeLease!.runtime.turnTimeoutMs,
              ),
            }
          : {
              turnTimeoutMs: Math.min(
                this.#turnTimeoutMs,
                command.payload.budgets?.maximumRunDurationMs ?? Number.MAX_SAFE_INTEGER,
              ),
            }),
      };
      const runner = new PiCloudTurnRunner({
        ...commonRunnerOptions,
        createAgentTools: ({ toolOutputDirectory, stepWorldState, captureSamplingStep }) => {
          if (activeSandbox === undefined) {
            let stepSequence = 0;
            let currentStep: Awaited<ReturnType<typeof captureSamplingStep>>["step"] | undefined;
            let currentSamplingAttempt: number | undefined;
            let currentSamplingHeadersIssued = false;
            const captureStep = async (purpose: "agent" | "context_maintenance") => {
              const captured = await captureSamplingStep(
                async () => {
                  const world = await stepWorldState.capture();
                  const step = createCloudStepContext({
                    sequence: (stepSequence += 1),
                    turnContextSha256: cloudTurn.sha256,
                    attemptContextSha256: cloudAttempt.sha256,
                    allowedTools: cloudTurn.context.tools.names,
                    activeTools: [],
                    worldState: world.worldState,
                  });
                  return { step, modelMessages: world.modelMessages };
                },
                { publishEvent: purpose === "agent" },
              );
              currentStep = captured.step;
              currentSamplingAttempt = captured.samplingAttempt;
              currentSamplingHeadersIssued = false;
              return captured;
            };
            return {
              tools: [...trustedTools],
              async systemPrompt(base: string) {
                return trustedTools.length === 0
                  ? base
                  : [base]
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
                              "A durable contact_supervisor Tool can reach the parent Agent across cloud Workers.",
                            ]
                          : [],
                      )
                      .join("\n");
              },
              async transformContext(messages, purpose = "agent") {
                currentStep = undefined;
                currentSamplingAttempt = undefined;
                const captured = await captureStep(purpose);
                const transformed = [...messages];
                for (const message of captured.modelMessages) {
                  const alreadyPresent = transformed.some(
                    (candidate) =>
                      candidate.role === "custom" &&
                      candidate.customType === message.customType &&
                      typeof candidate.details === "object" &&
                      candidate.details !== null &&
                      (candidate.details as { changeSha256?: unknown }).changeSha256 ===
                        message.details.changeSha256,
                  );
                  if (!alreadyPresent) {
                    transformed.push({ ...message, role: "custom", timestamp: Date.now() });
                  }
                }
                return transformed;
              },
              async transformHeaders(headers = {}) {
                if (currentSamplingHeadersIssued) await captureStep("context_maintenance");
                if (currentStep === undefined || currentSamplingAttempt === undefined) {
                  throw new Error("Model request preceded its Cloud Step capture");
                }
                currentSamplingHeadersIssued = true;
                return {
                  ...headers,
                  ...modelSamplingHeaders({
                    stepSequence: currentStep.context.sequence,
                    stepSha256: currentStep.sha256,
                    samplingAttempt: currentSamplingAttempt,
                  }),
                };
              },
            };
          }
          let stepSequence = 0;
          const remoteTools = createTrustedRemoteAgentTools({
            activationId: activeSandbox.activationId,
            executionLease: toolAssignment.executionLease,
            operationUrl: this.#broker.operationUrlFor(activeSandbox.activationId),
            turnContextSha256: cloudTurn.sha256,
            attemptContextSha256: cloudAttempt.sha256,
            allowedTools: cloudTurn.context.tools.names,
            captureStepContext: (activeTools, purpose = "agent") =>
              captureSamplingStep(
                async () => {
                  const captured = await stepWorldState.capture();
                  const step = createCloudStepContext({
                    sequence: (stepSequence += 1),
                    turnContextSha256: cloudTurn.sha256,
                    attemptContextSha256: cloudAttempt.sha256,
                    allowedTools: cloudTurn.context.tools.names,
                    activeTools,
                    worldState: captured.worldState,
                  });
                  return { step, modelMessages: captured.modelMessages };
                },
                { publishEvent: purpose === "agent" },
              ),
            onToolOperationStarted: () => stepWorldState.recordActive(),
            onToolOperationUnavailable: () => stepWorldState.recordUnavailable(),
            remainingToolCalls: command.payload.budgets?.remainingToolCalls ?? 128,
            maximumToolOutputBytes: command.payload.budgets?.maximumToolOutputBytes ?? 65_536,
            toolOutputDirectory,
            workingDirectory: command.payload.workingDirectory,
            ...(projectInstructions === undefined ? {} : { projectInstructions }),
            ...(downstreamTrace === undefined
              ? {}
              : {
                  traceparent: downstreamTrace.traceparent,
                  ...(downstreamTrace.tracestate === undefined
                    ? {}
                    : { tracestate: downstreamTrace.tracestate }),
                }),
          });
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
                          "Use stable workflow keys, keep one shared Workspace writer, and inspect every returned result. " +
                          "When a Child pauses for input, answer it through subagent_supervisor.",
                      ]
                    : [],
                  hasSupervisorContact
                    ? [
                        "A durable contact_supervisor Tool can reach the parent Agent across cloud Workers.",
                      ]
                    : [],
                )
                .join("\n");
            },
          };
        },
        ...(settlementGate === undefined
          ? {}
          : {
              observeEvent: (event) => {
                if (
                  event.type !== "compaction_start" &&
                  event.type !== "compaction_end" &&
                  event.type !== "auto_retry_start" &&
                  event.type !== "auto_retry_end"
                ) {
                  settlementGate.observe(event);
                }
              },
              prepareFollowUp: () => settlementGate.prepareFollowUp(),
            }),
      });
      onPiRunnerReady(runner);
      const result = await runner.run(command, publishEvent, signal);
      completedSuccessfully = true;
      return result;
    } finally {
      signal.removeEventListener("abort", abortSandbox);
      await fakeModel?.stop().catch(() => undefined);
      let cleanupError: unknown;
      if (activation !== undefined && completedSuccessfully && !signal.aborted) {
        const disposition =
          retainedWorkspaceRevision === undefined
            ? ({ kind: "destroy" } as const)
            : ({
                kind: "keep_warm",
                workspaceRevision: retainedWorkspaceRevision,
              } as const);
        await this.#broker
          .release(activation.activationId, toolAssignment, disposition)
          .catch((error: unknown) => {
            cleanupError = error;
          });
      } else {
        await stopSandbox().catch((error: unknown) => {
          cleanupError = error;
        });
      }
      await releaseModelRuntimeLease(modelRuntimeLease).catch((error: unknown) => {
        cleanupError ??= error;
      });
      if (cleanupError !== undefined) {
        throw safePiError(
          cleanupError,
          "trusted_runner_cleanup_failed",
          "Trusted Agent Runner cleanup could not be confirmed",
        );
      }
    }
  }
}
