import {
  AgentRunSupervisor,
  AgentRunSupervisorError,
  PiTurnCancelledError,
  PiTurnError,
} from "@pi-cloud/sandbox-supervisor";
import {
  PiCloudWireProtocolError,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type CancelTurnCommandMessage,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import {
  TurnCancellationBackendError,
  type TurnCancellationBackend,
  type TurnCancellationLifecycle,
  type TurnCancellationRequest,
  type TurnCancellationResult,
} from "./run-cancellation-executor.ts";
import {
  TurnExecutionBackendError,
  TurnExecutionCancelledError,
  type TurnExecutionBackend,
  type TurnExecutionLifecycle,
  type TurnExecutionRequest,
  type TurnExecutionResult,
} from "./run-executor.ts";
import {
  DurableEventStoreError,
  type FactChannel,
  type FactChannelFactory,
} from "./durable-event-store.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
} from "./session-lease-coordinator.ts";

export type AgentRunExecutionBackendOptions = {
  supervisor: AgentRunSupervisor;
  leaseCoordinator: SessionLeaseCoordinator;
  factChannels: FactChannelFactory;
  onEvent?: (message: EventPublishMessage) => Promise<void> | void;
  clock?: () => Date;
  idGenerator?: () => string;
  heartbeatIntervalMs?: number;
  onUnexpectedError?: (error: unknown) => void;
  metrics?: PiCloudMetrics;
};

type TrackedLeaseExecution = {
  prepared: ReturnType<AgentRunSupervisor["prepare"]>;
  execution: Promise<TurnExecutionResult>;
  writer: FactChannel;
  writerClosing?: Promise<void>;
  failure?: TurnExecutionBackendError;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function postgresRetryCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return code === "40P01" || code === "40001" ? code : undefined;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("agent runner backend clock must return a valid Date");
  }
  return value;
}

function positiveSafeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      `${name} is outside the wire protocol range`,
      false,
    );
  }
  return parsed;
}

function normalizeBackendError(error: unknown): TurnExecutionBackendError {
  if (error instanceof TurnExecutionBackendError) return error;
  if (error instanceof PiTurnCancelledError) {
    if (error.reason === "session_lease_revoked") {
      return new TurnExecutionBackendError(
        "session_lease_revoked",
        "Execution lease was revoked and the runtime was stopped",
        false,
        true,
      );
    }
    return new TurnExecutionCancelledError(error.reason, error.forced);
  }
  if (error instanceof SessionLeaseCoordinatorError || error instanceof PiTurnError) {
    return new TurnExecutionBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof DurableEventStoreError) {
    return new TurnExecutionBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof AgentRunSupervisorError) {
    return new TurnExecutionBackendError(error.code, error.message, false);
  }
  if (error instanceof PiCloudWireProtocolError) {
    return new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor wire protocol validation failed",
      false,
    );
  }
  return new TurnExecutionBackendError("agent_runner_error", "Agent runner execution failed", true);
}

function normalizeCancellationError(error: unknown): TurnCancellationBackendError {
  if (error instanceof TurnCancellationBackendError) return error;
  if (error instanceof SessionLeaseCoordinatorError || error instanceof PiTurnError) {
    return new TurnCancellationBackendError(error.code, error.message, error.retryable);
  }
  if (error instanceof AgentRunSupervisorError) {
    return new TurnCancellationBackendError(error.code, error.message, false);
  }
  if (error instanceof PiCloudWireProtocolError) {
    return new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor wire protocol validation failed",
      false,
    );
  }
  return new TurnCancellationBackendError(
    "agent_runner_error",
    "Agent runner cancellation failed",
    true,
  );
}

function validateEventAck(eventMessage: EventPublishMessage, value: unknown): EventAckMessage {
  const parsed = parseControlToSupervisorMessage(value);
  if (
    parsed.type !== "event.ack" ||
    parsed.payload.sessionId !== eventMessage.payload.event.sessionId ||
    parsed.payload.executionLease !== eventMessage.payload.executionLease ||
    parsed.payload.acknowledgedThroughSeq !== eventMessage.payload.event.seq
  ) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Event ACK identity does not match the published event",
      false,
    );
  }
  return parsed;
}

function validateAck(
  request: TurnExecutionRequest,
  command: ExecuteTurnCommandMessage,
  value: unknown,
) {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "command.ack") {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor returned a non-ACK message",
      false,
    );
  }
  if (
    parsed.payload.requestId !== request.runId ||
    parsed.payload.sessionId !== request.sessionId ||
    parsed.payload.turnId !== request.turnId ||
    parsed.payload.executionLease !== command.payload.executionLease
  ) {
    throw new TurnExecutionBackendError(
      "backend_protocol_violation",
      "Supervisor ACK identity does not match the delivered command",
      false,
    );
  }
  return parsed;
}

function validateCancellationAck(
  request: TurnCancellationRequest,
  command: CancelTurnCommandMessage,
  value: unknown,
) {
  const parsed = parseSupervisorToControlMessage(value);
  if (parsed.type !== "command.ack") {
    throw new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor returned a non-ACK cancellation response",
      false,
    );
  }
  if (
    parsed.payload.requestId !== request.controlRequestId ||
    parsed.payload.sessionId !== request.target.sessionId ||
    parsed.payload.turnId !== request.target.turnId ||
    parsed.payload.executionLease !== command.payload.executionLease
  ) {
    throw new TurnCancellationBackendError(
      "backend_protocol_violation",
      "Supervisor cancellation ACK identity does not match the delivered command",
      false,
    );
  }
  return parsed;
}

export class AgentRunExecutionBackend implements TurnExecutionBackend, TurnCancellationBackend {
  readonly #supervisor: AgentRunSupervisor;
  readonly #leaseCoordinator: SessionLeaseCoordinator;
  readonly #factChannels: FactChannelFactory;
  readonly #onEvent: ((message: EventPublishMessage) => Promise<void> | void) | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #heartbeatIntervalMs: number;
  readonly #onUnexpectedError: ((error: unknown) => void) | undefined;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #trackedLeaseExecutions = new Map<string, TrackedLeaseExecution>();
  #heartbeatAbort: AbortController | undefined;
  #heartbeatTask: Promise<void> | undefined;
  #heartbeatFailure: TurnExecutionBackendError | undefined;

  constructor(options: AgentRunExecutionBackendOptions) {
    this.#supervisor = options.supervisor;
    this.#leaseCoordinator = options.leaseCoordinator;
    this.#factChannels = options.factChannels;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? this.#leaseCoordinator.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
    this.#onUnexpectedError = options.onUnexpectedError;
    this.#metrics = options.metrics;
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult> {
    let acknowledgement: { executionLease: string } | undefined;
    let factChannel: FactChannel | undefined;
    let prepared: ReturnType<AgentRunSupervisor["prepare"]> | undefined;
    let tracked: TrackedLeaseExecution | undefined;
    let durableStarted = false;

    try {
      acknowledgement = await this.#measurePreparation("execution_lease", () =>
        this.#leaseCoordinator.acquire(request),
      );
      factChannel = await this.#measurePreparation("fact_channel", () =>
        this.#factChannels.open({
          executionLease: acknowledgement!.executionLease,
          sessionId: request.sessionId,
          piSession: { id: request.piSessionId, lane: request.piSessionLane },
          turnId: request.turnId,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
        }),
      );
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.execute",
        payload: {
          idempotencyKey: request.idempotencyKey,
          tenantId: request.tenantId,
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          piSession: { id: request.piSessionId, lane: request.piSessionLane },
          runId: request.runId,
          turnId: request.turnId,
          agentId: "root",
          executionLease: acknowledgement.executionLease,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
          agent: request.agent,
          input: { kind: "prompt", text: request.input.prompt },
          executionMode: request.executionMode,
          sandboxProfileKey: request.sandboxProfileKey,
          workingDirectory: request.workingDirectory,
          toolCapabilities: request.toolCapabilities,
          ...(request.agentSystemPrompt === undefined
            ? {}
            : { agentSystemPrompt: request.agentSystemPrompt }),
          model: {
            profileId: request.model.profileId,
            provider: request.model.provider,
            modelId: request.model.modelId,
            thinkingLevel: request.model.thinkingLevel,
            serviceTier: request.model.serviceTier,
            credentialBindingId: request.model.credentialBindingId,
            credentialBindingVersion: positiveSafeInteger(
              request.model.credentialBindingVersion,
              "credential binding version",
            ),
          },
          environment: request.environment,
          ...(request.budgets === undefined ? {} : { budgets: request.budgets }),
          ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
        },
      });
      if (parsed.type !== "command.turn.execute") {
        throw new TurnExecutionBackendError(
          "backend_protocol_violation",
          "Constructed supervisor command was invalid",
          false,
        );
      }
      const command = parsed;
      const prepareStartedAt = performance.now();
      prepared = this.#supervisor.prepare(command, async (message) => {
        const eventMessage = parseSupervisorToControlMessage(message);
        if (
          eventMessage.type !== "event.publish" ||
          eventMessage.payload.executionLease !== acknowledgement?.executionLease ||
          eventMessage.payload.event.sessionId !== request.sessionId ||
          eventMessage.payload.event.turnId !== request.turnId
        ) {
          throw new TurnExecutionBackendError(
            "backend_protocol_violation",
            "Supervisor event identity does not match the running command",
            false,
          );
        }
        const eventAck = validateEventAck(eventMessage, await factChannel!.ingest(eventMessage));
        await this.#onEvent?.(eventMessage);
        return eventAck;
      });
      this.#metrics?.runPreparationDuration.observe(
        { stage: "runner_prepare", outcome: "completed" },
        (performance.now() - prepareStartedAt) / 1_000,
      );
      const ack = validateAck(request, command, prepared.ack);
      if (ack.payload.status === "rejected") {
        throw new TurnExecutionBackendError(
          ack.payload.code,
          ack.payload.message,
          ack.payload.retryable,
        );
      }

      await this.#measurePreparation("durable_started", () => lifecycle.started(acknowledgement));
      durableStarted = true;
      const execution = prepared.run();
      tracked = this.#registerGrantExecution(request.sessionId, prepared, execution, factChannel);
      try {
        let result: TurnExecutionResult;
        try {
          result = await execution;
        } catch (error: unknown) {
          if (tracked.failure !== undefined) throw tracked.failure;
          throw error;
        }
        if (tracked.failure !== undefined) throw tracked.failure;
        return result;
      } finally {
        try {
          await this.#closeTrackedChannel(tracked);
        } finally {
          await this.#unregisterGrantExecution(request.sessionId, tracked);
        }
      }
    } catch (error: unknown) {
      if (!durableStarted) {
        prepared?.releaseBeforeStart();
        if (factChannel !== undefined) {
          await factChannel.close().catch(() => undefined);
          factChannel = undefined;
        }
        if (acknowledgement !== undefined) {
          await this.#leaseCoordinator.releaseAcquired(request, acknowledgement).catch(() => {
            // Preserve the original delivery error. The durable grant expires and
            // the next acquisition replaces it if cleanup also failed.
          });
        }
      }
      const normalized = normalizeBackendError(error);
      normalized.lastEventSeq ??= prepared?.lastAcknowledgedEventSeq();
      if (normalized.code === "agent_runner_error") {
        try {
          this.#onUnexpectedError?.(error);
        } catch {
          // Diagnostics must never replace the original execution failure.
        }
      }
      throw normalized;
    } finally {
      if (factChannel !== undefined && tracked === undefined) await factChannel.close();
    }
  }

  async #measurePreparation<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      this.#metrics?.runPreparationDuration.observe(
        { stage, outcome: "completed" },
        (performance.now() - startedAt) / 1_000,
      );
      return result;
    } catch (error: unknown) {
      this.#metrics?.runPreparationDuration.observe(
        { stage, outcome: "failed" },
        (performance.now() - startedAt) / 1_000,
      );
      throw error;
    }
  }

  async cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult> {
    try {
      const acknowledgement = await this.#leaseCoordinator.currentAssignment(request.target);
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.cancel",
        payload: {
          controlRequestId: request.controlRequestId,
          targetRunId: request.target.runId,
          idempotencyKey: request.idempotencyKey,
          tenantId: request.target.tenantId,
          projectId: request.target.projectId,
          workspaceId: request.target.workspaceId,
          sessionId: request.target.sessionId,
          runId: request.target.runId,
          turnId: request.target.turnId,
          agentId: "root",
          executionLease: acknowledgement.executionLease,
          reason: request.reason,
          gracePeriodMs: request.gracePeriodMs,
        },
      });
      if (parsed.type !== "command.turn.cancel") {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Constructed supervisor cancellation command was invalid",
          false,
        );
      }
      const command = parsed;
      const prepared = this.#supervisor.prepareCancellation(command);
      const ack = validateCancellationAck(request, command, prepared.ack);
      if (ack.payload.status === "rejected") {
        throw new TurnCancellationBackendError(
          ack.payload.code,
          ack.payload.message,
          ack.payload.retryable,
        );
      }

      await lifecycle.started(acknowledgement);
      const result = await prepared.run();
      const tracked = this.#trackedLeaseExecutions.get(request.target.sessionId);
      if (tracked !== undefined) await this.#closeTrackedChannel(tracked);
      return result;
    } catch (error: unknown) {
      throw normalizeCancellationError(error);
    }
  }

  #registerGrantExecution(
    sessionId: string,
    prepared: ReturnType<AgentRunSupervisor["prepare"]>,
    execution: Promise<TurnExecutionResult>,
    writer: FactChannel,
  ): TrackedLeaseExecution {
    const tracked: TrackedLeaseExecution = { prepared, execution, writer };
    if (this.#trackedLeaseExecutions.has(sessionId)) {
      tracked.failure = new TurnExecutionBackendError(
        "session_lease_monitor_invariant",
        "Session already had a tracked ExecutionLease",
        false,
        true,
      );
      prepared.revokeLease();
      return tracked;
    }
    this.#trackedLeaseExecutions.set(sessionId, tracked);
    if (this.#heartbeatFailure !== undefined) {
      tracked.failure = this.#heartbeatFailure;
      prepared.revokeLease();
    } else {
      this.#startHeartbeatTask();
    }
    return tracked;
  }

  #closeTrackedChannel(tracked: TrackedLeaseExecution): Promise<void> {
    tracked.writerClosing ??= tracked.writer.close();
    return tracked.writerClosing;
  }

  async #unregisterGrantExecution(
    sessionId: string,
    tracked: TrackedLeaseExecution,
  ): Promise<void> {
    if (this.#trackedLeaseExecutions.get(sessionId) === tracked) {
      this.#trackedLeaseExecutions.delete(sessionId);
    }
    if (this.#trackedLeaseExecutions.size !== 0) return;
    this.#heartbeatAbort?.abort();
    await this.#heartbeatTask;
  }

  #startHeartbeatTask(): void {
    if (this.#heartbeatTask !== undefined || this.#heartbeatFailure !== undefined) return;
    const abort = new AbortController();
    this.#heartbeatAbort = abort;
    const task = this.#runHeartbeatTask(abort.signal).finally(() => {
      if (this.#heartbeatTask === task) {
        this.#heartbeatTask = undefined;
        this.#heartbeatAbort = undefined;
        if (this.#trackedLeaseExecutions.size > 0 && this.#heartbeatFailure === undefined) {
          this.#startHeartbeatTask();
        }
      }
    });
    this.#heartbeatTask = task;
  }

  async #runHeartbeatTask(signal: AbortSignal): Promise<void> {
    try {
      const identity = await this.#leaseCoordinator.heartbeatIdentity();
      while (!signal.aborted && this.#trackedLeaseExecutions.size > 0) {
        const heartbeat = this.#supervisor.createHeartbeat(identity);
        let acknowledgement;
        for (let attempt = 1; ; attempt += 1) {
          try {
            acknowledgement = await this.#leaseCoordinator.renewFromHeartbeat(heartbeat);
            break;
          } catch (error: unknown) {
            if (postgresRetryCode(error) === undefined || attempt >= 5 || signal.aborted) {
              throw error;
            }
            await wait(25 * attempt, signal);
          }
        }
        const result = this.#supervisor.applyHeartbeatAcknowledgement(heartbeat, acknowledgement);
        if (result.revokedAssignments !== result.revokedSessionIds.length) {
          throw new AgentRunSupervisorError(
            "invalid_heartbeat_result",
            "Supervisor heartbeat result was internally inconsistent",
          );
        }
        for (const sessionId of result.revokedSessionIds) {
          const tracked = this.#trackedLeaseExecutions.get(sessionId);
          if (tracked !== undefined) tracked.failure = this.#leaseRenewalFailure();
        }
        await wait(this.#heartbeatIntervalMs, signal);
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      this.#onUnexpectedError?.(error);
      const failure = this.#leaseRenewalFailure();
      this.#heartbeatFailure = failure;
      await this.#leaseCoordinator.quarantineSandbox().catch(() => undefined);
      const trackedLeaseExecutions = [...this.#trackedLeaseExecutions.values()];
      for (const tracked of trackedLeaseExecutions) {
        tracked.failure = failure;
        tracked.prepared.revokeLease();
      }
      await Promise.allSettled(trackedLeaseExecutions.map((tracked) => tracked.execution));
    }
  }

  #leaseRenewalFailure(): TurnExecutionBackendError {
    return new TurnExecutionBackendError(
      "session_lease_renewal_failed",
      "ExecutionLease renewal failed and the runtime was revoked",
      false,
      true,
    );
  }
}
