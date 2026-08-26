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
} from "./run-command-executor.ts";
import {
  DurableEventStoreError,
  type DurableEventIngestor,
  type DurableEventWriter,
} from "./durable-event-store.ts";
import {
  ExecutionGrantCoordinator,
  ExecutionGrantCoordinatorError,
} from "./execution-grant-coordinator.ts";

export type AgentRunExecutionBackendOptions = {
  supervisor: AgentRunSupervisor;
  grantCoordinator: ExecutionGrantCoordinator;
  eventIngestor: DurableEventIngestor;
  onEvent?: (message: EventPublishMessage) => Promise<void> | void;
  clock?: () => Date;
  idGenerator?: () => string;
  heartbeatIntervalMs?: number;
  onUnexpectedError?: (error: unknown) => void;
};

type TrackedGrantExecution = {
  prepared: ReturnType<AgentRunSupervisor["prepare"]>;
  execution: Promise<TurnExecutionResult>;
  writer: DurableEventWriter;
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
    if (error.reason === "execution_grant_revoked") {
      return new TurnExecutionBackendError(
        "execution_grant_revoked",
        "Execution lease was revoked and the runtime was stopped",
        false,
        true,
      );
    }
    return new TurnExecutionCancelledError(error.reason, error.forced);
  }
  if (error instanceof ExecutionGrantCoordinatorError || error instanceof PiTurnError) {
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
  if (error instanceof ExecutionGrantCoordinatorError || error instanceof PiTurnError) {
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
    parsed.payload.executionGrant !== eventMessage.payload.executionGrant ||
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
    parsed.payload.commandId !== request.commandId ||
    parsed.payload.sessionId !== request.sessionId ||
    parsed.payload.turnId !== request.turnId ||
    parsed.payload.executionGrant !== command.payload.executionGrant
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
    parsed.payload.commandId !== request.commandId ||
    parsed.payload.sessionId !== request.target.sessionId ||
    parsed.payload.turnId !== request.target.turnId ||
    parsed.payload.executionGrant !== command.payload.executionGrant
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
  readonly #grantCoordinator: ExecutionGrantCoordinator;
  readonly #eventIngestor: DurableEventIngestor;
  readonly #onEvent: ((message: EventPublishMessage) => Promise<void> | void) | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #heartbeatIntervalMs: number;
  readonly #onUnexpectedError: ((error: unknown) => void) | undefined;
  readonly #trackedGrantExecutions = new Map<string, TrackedGrantExecution>();
  #heartbeatAbort: AbortController | undefined;
  #heartbeatTask: Promise<void> | undefined;
  #heartbeatFailure: TurnExecutionBackendError | undefined;

  constructor(options: AgentRunExecutionBackendOptions) {
    this.#supervisor = options.supervisor;
    this.#grantCoordinator = options.grantCoordinator;
    this.#eventIngestor = options.eventIngestor;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? this.#grantCoordinator.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    );
    this.#onUnexpectedError = options.onUnexpectedError;
  }

  async execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult> {
    let acknowledgement: { executionGrant: string } | undefined;
    let eventWriter: DurableEventWriter | undefined;
    let prepared: ReturnType<AgentRunSupervisor["prepare"]> | undefined;
    let tracked: TrackedGrantExecution | undefined;
    let durableStarted = false;

    try {
      acknowledgement = await this.#grantCoordinator.acquire(request);
      eventWriter = await this.#eventIngestor.open({
        executionGrant: acknowledgement.executionGrant,
        sessionId: request.sessionId,
        turnId: request.turnId,
        nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
      });
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.execute",
        payload: {
          commandId: request.commandId,
          idempotencyKey: request.idempotencyKey,
          tenantId: request.tenantId,
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          runId: request.runId,
          turnId: request.turnId,
          agentId: "root",
          executionGrant: acknowledgement.executionGrant,
          nextEventSeq: positiveSafeInteger(request.nextEventSeq, "next event sequence"),
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
      prepared = this.#supervisor.prepare(command, async (message) => {
        const eventMessage = parseSupervisorToControlMessage(message);
        const publications = eventMessage.type === "event.publish" ? [eventMessage] : [];
        if (
          publications.length === 0 ||
          publications.some(
            (publication) =>
              publication.payload.executionGrant !== acknowledgement?.executionGrant ||
              publication.payload.event.sessionId !== request.sessionId ||
              publication.payload.event.turnId !== request.turnId,
          )
        ) {
          throw new TurnExecutionBackendError(
            "backend_protocol_violation",
            "Supervisor event identity does not match the running command",
            false,
          );
        }
        const last = publications.at(-1)!;
        const eventAck = validateEventAck(last, await eventWriter!.ingest(eventMessage));
        for (const publication of publications) await this.#onEvent?.(publication);
        return eventAck;
      });
      const ack = validateAck(request, command, prepared.ack);
      if (ack.payload.status === "rejected") {
        throw new TurnExecutionBackendError(
          ack.payload.code,
          ack.payload.message,
          ack.payload.retryable,
        );
      }

      await lifecycle.started(acknowledgement);
      durableStarted = true;
      const execution = prepared.run();
      tracked = this.#registerGrantExecution(request.sessionId, prepared, execution, eventWriter);
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
          await this.#closeTrackedWriter(tracked);
        } finally {
          await this.#unregisterGrantExecution(request.sessionId, tracked);
        }
      }
    } catch (error: unknown) {
      if (!durableStarted) {
        prepared?.releaseBeforeStart();
        if (eventWriter !== undefined) {
          await eventWriter.close().catch(() => undefined);
          eventWriter = undefined;
        }
        if (acknowledgement !== undefined) {
          await this.#grantCoordinator.releaseAcquired(request, acknowledgement).catch(() => {
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
      if (eventWriter !== undefined && tracked === undefined) await eventWriter.close();
    }
  }

  async cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult> {
    try {
      const acknowledgement = await this.#grantCoordinator.currentAssignment(request.target);
      const parsed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: this.#idGenerator(),
        sentAt: validDate(this.#clock).toISOString(),
        type: "command.turn.cancel",
        payload: {
          commandId: request.commandId,
          targetCommandId: request.target.commandId,
          idempotencyKey: request.idempotencyKey,
          tenantId: request.target.tenantId,
          projectId: request.target.projectId,
          workspaceId: request.target.workspaceId,
          sessionId: request.target.sessionId,
          runId: request.target.runId,
          turnId: request.target.turnId,
          agentId: "root",
          executionGrant: acknowledgement.executionGrant,
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
      const tracked = this.#trackedGrantExecutions.get(request.target.sessionId);
      if (tracked !== undefined) await this.#closeTrackedWriter(tracked);
      return result;
    } catch (error: unknown) {
      throw normalizeCancellationError(error);
    }
  }

  #registerGrantExecution(
    sessionId: string,
    prepared: ReturnType<AgentRunSupervisor["prepare"]>,
    execution: Promise<TurnExecutionResult>,
    writer: DurableEventWriter,
  ): TrackedGrantExecution {
    const tracked: TrackedGrantExecution = { prepared, execution, writer };
    if (this.#trackedGrantExecutions.has(sessionId)) {
      tracked.failure = new TurnExecutionBackendError(
        "execution_grant_monitor_invariant",
        "Session already had a tracked ExecutionGrant",
        false,
        true,
      );
      prepared.revokeGrant();
      return tracked;
    }
    this.#trackedGrantExecutions.set(sessionId, tracked);
    if (this.#heartbeatFailure !== undefined) {
      tracked.failure = this.#heartbeatFailure;
      prepared.revokeGrant();
    } else {
      this.#startHeartbeatTask();
    }
    return tracked;
  }

  #closeTrackedWriter(tracked: TrackedGrantExecution): Promise<void> {
    tracked.writerClosing ??= tracked.writer.close();
    return tracked.writerClosing;
  }

  async #unregisterGrantExecution(
    sessionId: string,
    tracked: TrackedGrantExecution,
  ): Promise<void> {
    if (this.#trackedGrantExecutions.get(sessionId) === tracked) {
      this.#trackedGrantExecutions.delete(sessionId);
    }
    if (this.#trackedGrantExecutions.size !== 0) return;
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
        if (this.#trackedGrantExecutions.size > 0 && this.#heartbeatFailure === undefined) {
          this.#startHeartbeatTask();
        }
      }
    });
    this.#heartbeatTask = task;
  }

  async #runHeartbeatTask(signal: AbortSignal): Promise<void> {
    try {
      const identity = await this.#grantCoordinator.heartbeatIdentity();
      while (!signal.aborted && this.#trackedGrantExecutions.size > 0) {
        const heartbeat = this.#supervisor.createHeartbeat(identity);
        let acknowledgement;
        for (let attempt = 1; ; attempt += 1) {
          try {
            acknowledgement = await this.#grantCoordinator.renewFromHeartbeat(heartbeat);
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
          const tracked = this.#trackedGrantExecutions.get(sessionId);
          if (tracked !== undefined) tracked.failure = this.#grantRenewalFailure();
        }
        await wait(this.#heartbeatIntervalMs, signal);
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      this.#onUnexpectedError?.(error);
      const failure = this.#grantRenewalFailure();
      this.#heartbeatFailure = failure;
      await this.#grantCoordinator.quarantineSandbox().catch(() => undefined);
      const trackedGrantExecutions = [...this.#trackedGrantExecutions.values()];
      for (const tracked of trackedGrantExecutions) {
        tracked.failure = failure;
        tracked.prepared.revokeGrant();
      }
      await Promise.allSettled(trackedGrantExecutions.map((tracked) => tracked.execution));
    }
  }

  #grantRenewalFailure(): TurnExecutionBackendError {
    return new TurnExecutionBackendError(
      "execution_grant_renewal_failed",
      "ExecutionGrant renewal failed and the runtime was revoked",
      false,
      true,
    );
  }
}
