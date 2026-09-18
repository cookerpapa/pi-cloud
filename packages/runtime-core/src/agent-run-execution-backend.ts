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
import { measureRunPreparation, type PiCloudMetrics } from "@pi-cloud/observability";
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
  type TurnExecutionAdmission,
} from "./run-executor.ts";
import type { Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";
import { registerExecutionPublication } from "./execution-publication.ts";
import type { ExecutionLogWriter, ExecutionLogFactory } from "./execution-log.ts";
import {
  SessionLeaseCoordinator,
  SessionLeaseCoordinatorError,
} from "./session-lease-coordinator.ts";

export type AgentRunExecutionBackendOptions = {
  supervisor: AgentRunSupervisor;
  leaseCoordinator: SessionLeaseCoordinator;
  executionLogs: ExecutionLogFactory;
  onEvent?: (message: EventPublishMessage) => Promise<void> | void;
  clock?: () => Date;
  idGenerator?: () => string;
  heartbeatIntervalMs?: number;
  onUnexpectedError?: (error: unknown) => void;
  metrics?: PiCloudMetrics;
};

type TrackedExecution = {
  prepared: ReturnType<AgentRunSupervisor["prepare"]>;
  execution: Promise<TurnExecutionResult>;
  writer: ExecutionLogWriter;
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
    parsed.payload.executionReference !== eventMessage.payload.executionReference ||
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
    parsed.payload.executionReference !== command.payload.executionReference
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
    parsed.payload.executionReference !== command.payload.executionReference
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
  readonly #executionLogs: ExecutionLogFactory;
  readonly #onEvent: ((message: EventPublishMessage) => Promise<void> | void) | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #heartbeatIntervalMs: number;
  readonly #onUnexpectedError: ((error: unknown) => void) | undefined;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #trackedExecutions = new Map<string, TrackedExecution>();
  #heartbeatAbort: AbortController | undefined;
  #heartbeatTask: Promise<void> | undefined;
  #heartbeatFailure: TurnExecutionBackendError | undefined;

  constructor(options: AgentRunExecutionBackendOptions) {
    this.#supervisor = options.supervisor;
    this.#leaseCoordinator = options.leaseCoordinator;
    this.#executionLogs = options.executionLogs;
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

  async admit(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    mark: (stage: string) => void,
  ): Promise<TurnExecutionAdmission> {
    const reference = await this.#leaseCoordinator.acquireInTransaction(transaction, request, mark);
    const publication = await registerExecutionPublication(transaction, {
      ...reference,
      sessionId: request.sessionId,
      turnId: request.turnId,
      piSession: {
        id: request.piSessionId,
        lane: request.piSessionLane,
        writerId: request.piSessionWriterId,
      },
      nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
    });
    return { ...reference, publication };
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
    admission?: TurnExecutionAdmission,
  ): Promise<TurnExecutionResult> {
    if (!admission) throw new Error("Agent execution requires committed admission");
    const acknowledgement = admission;
    let executionLog: ExecutionLogWriter | undefined;
    let prepared: ReturnType<AgentRunSupervisor["prepare"]> | undefined;
    let tracked: TrackedExecution | undefined;

    try {
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
          piSession: {
            id: request.piSessionId,
            lane: request.piSessionLane,
            writerId: request.piSessionWriterId,
          },
          runId: request.runId,
          turnId: request.turnId,
          agentId: "root",
          executionReference: acknowledgement.executionReference,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
          agent: request.agent,
          input: { kind: "prompt", text: request.input.prompt },
          executionMode: request.executionMode,
          sessionKind: request.sessionKind,
          workspaceSeedKind: request.workspaceSeedKind,
          ...(request.computeSessionId === undefined
            ? {}
            : { computeSessionId: request.computeSessionId }),
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
          eventMessage.payload.executionReference !== acknowledgement?.executionReference ||
          eventMessage.payload.event.sessionId !== request.sessionId ||
          eventMessage.payload.event.turnId !== request.turnId
        ) {
          throw new TurnExecutionBackendError(
            "backend_protocol_violation",
            "Supervisor event identity does not match the running command",
            false,
          );
        }
        const eventAck = validateEventAck(eventMessage, await executionLog!.ingest(eventMessage));
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

      await measureRunPreparation(request.runId, "durable_started", this.#metrics, () =>
        lifecycle.started(acknowledgement),
      );
      executionLog = await measureRunPreparation(request.runId, "log_open", this.#metrics, () =>
        this.#executionLogs.open({
          ...admission,
          sessionId: request.sessionId,
          piSession: {
            id: request.piSessionId,
            lane: request.piSessionLane,
            writerId: request.piSessionWriterId,
          },
          turnId: request.turnId,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
        }),
      );
      const execution = prepared.run();
      tracked = this.#registerExecution(request.sessionId, prepared, execution, executionLog);
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
        lifecycle.executionExited();
        try {
          await this.#closeTrackedChannel(tracked);
        } finally {
          await this.#unregisterExecution(request.sessionId, tracked);
        }
      }
    } catch (error: unknown) {
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
      if (!tracked) {
        prepared?.releaseBeforeStart();
        lifecycle.executionExited();
      }
      if (executionLog !== undefined && tracked === undefined) await executionLog.close();
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
          executionReference: acknowledgement.executionReference,
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
      const tracked = this.#trackedExecutions.get(request.target.sessionId);
      if (tracked !== undefined) await this.#closeTrackedChannel(tracked);
      return result;
    } catch (error: unknown) {
      throw normalizeCancellationError(error);
    }
  }

  #registerExecution(
    sessionId: string,
    prepared: ReturnType<AgentRunSupervisor["prepare"]>,
    execution: Promise<TurnExecutionResult>,
    writer: ExecutionLogWriter,
  ): TrackedExecution {
    const tracked: TrackedExecution = { prepared, execution, writer };
    if (this.#trackedExecutions.has(sessionId)) {
      tracked.failure = new TurnExecutionBackendError(
        "session_lease_monitor_invariant",
        "Session already had a tracked ExecutionReference",
        false,
        true,
      );
      prepared.revokeExecution();
      return tracked;
    }
    this.#trackedExecutions.set(sessionId, tracked);
    if (this.#heartbeatFailure !== undefined) {
      tracked.failure = this.#heartbeatFailure;
      prepared.revokeExecution();
    } else {
      this.#startHeartbeatTask();
    }
    return tracked;
  }

  #closeTrackedChannel(tracked: TrackedExecution): Promise<void> {
    tracked.writerClosing ??= tracked.writer.close();
    return tracked.writerClosing;
  }

  async #unregisterExecution(sessionId: string, tracked: TrackedExecution): Promise<void> {
    if (this.#trackedExecutions.get(sessionId) === tracked) {
      this.#trackedExecutions.delete(sessionId);
    }
    if (this.#trackedExecutions.size !== 0) return;
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
        if (this.#trackedExecutions.size > 0 && this.#heartbeatFailure === undefined) {
          this.#startHeartbeatTask();
        }
      }
    });
    this.#heartbeatTask = task;
  }

  async #runHeartbeatTask(signal: AbortSignal): Promise<void> {
    try {
      const identity = await this.#leaseCoordinator.heartbeatIdentity();
      while (!signal.aborted && this.#trackedExecutions.size > 0) {
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
          const tracked = this.#trackedExecutions.get(sessionId);
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
      const trackedExecutions = [...this.#trackedExecutions.values()];
      for (const tracked of trackedExecutions) {
        tracked.failure = failure;
        tracked.prepared.revokeExecution();
      }
      await Promise.allSettled(trackedExecutions.map((tracked) => tracked.execution));
    }
  }

  #leaseRenewalFailure(): TurnExecutionBackendError {
    return new TurnExecutionBackendError(
      "session_lease_renewal_failed",
      "ExecutionReference renewal failed and the runtime was revoked",
      false,
      true,
    );
  }
}
