import { createHash, randomUUID } from "node:crypto";
import { KafkaLogConsumer, type KafkaLogRecord } from "@pi-cloud/event-log";
import {
  createExecutionLease,
  parseExecutionLease,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { ToolBrokerError } from "./sandbox-provider.ts";
import type { ToolBroker } from "./tool-broker.ts";
import { parseTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import { DEFAULT_TOOL_TRANSPORT_CAPACITY } from "./tool-transport-capacity.ts";

type LogFact = {
  kind: string;
  scope: Pick<AcceptedToolCommand["scope"], "attemptId" | "writerId"> &
    Partial<AcceptedToolCommand["scope"]>;
  closesWriter?: boolean;
  events?: readonly { type: string; payload: { toolCallId?: string } }[];
};
type Outcome = {
  activationId: string;
  attemptId: string;
  writerId: string;
  hash: string;
  result?: Promise<ToolSandboxOperationResponse>;
  retired: boolean;
  settled: boolean;
};
type CommandBroker = Pick<ToolBroker, "execute" | "ownsToolBinding" | "assertToolResultReader">;

function callKey(scope: LogFact["scope"], toolCallId: string): string {
  return JSON.stringify([
    scope.tenantId,
    scope.sessionId,
    scope.turnId,
    scope.runId,
    scope.attemptId,
    scope.fencingToken,
    toolCallId,
  ]);
}

/** Boot-local bindings do not survive a Broker failure. Kafka reconnect can
 * redeliver within this boot; a new boot must never auto-replay an old effect. */
export class KafkaToolCommandConsumer {
  readonly #broker: CommandBroker;
  readonly #consumer: KafkaLogConsumer<LogFact>;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #next = new Map<number, bigint>();
  readonly #sealed = new Set<string>();
  readonly #sealedWriters = new Set<string>();
  readonly #attemptWriters = new Map<string, string>();
  readonly #results = new Map<string, Outcome>();
  readonly #calls = new Map<
    string,
    {
      activationId: string;
      attemptId: string;
      writerId: string;
      operations: Set<string>;
      closed: boolean;
    }
  >();
  readonly #completed = new Map<string, number>();
  readonly #maximumResultBytes: number;
  readonly #maximumActiveCommands: number;
  #retainedBytes = 0;
  #peakRetainedBytes = 0;
  #releasedResults = 0;
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #sweeper: NodeJS.Timeout;
  #active = 0;
  #consumed = 0;
  #commands = 0;
  #closed = false;

  constructor(options: {
    broker: CommandBroker;
    brokers: readonly string[];
    topic: string;
    instanceId?: string;
    metrics?: PiCloudMetrics;
    maximumResultBytes?: number;
    maximumActiveCommands?: number;
  }) {
    this.#broker = options.broker;
    this.#metrics = options.metrics;
    this.#metrics?.toolResultCacheBytes.set(0);
    this.#maximumResultBytes = options.maximumResultBytes ?? 64 * 1024 * 1024;
    this.#maximumActiveCommands =
      options.maximumActiveCommands ?? DEFAULT_TOOL_TRANSPORT_CAPACITY.maximumActiveCommands;
    if (!Number.isSafeInteger(this.#maximumActiveCommands) || this.#maximumActiveCommands < 1)
      throw new TypeError("maximumActiveCommands must be a positive integer");
    if (!Number.isSafeInteger(this.#maximumResultBytes) || this.#maximumResultBytes < 1)
      throw new TypeError("maximumResultBytes must be a positive integer");
    const boot = options.instanceId ?? randomUUID();
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      topic: options.topic,
      clientId: `tool-commands-${boot}`,
      groupId: `pi-cloud-tool-commands-${boot}`,
      commitMessages: false,
      decode: (value) => JSON.parse(value.toString()) as LogFact,
      replayOffsets: async (bounds) =>
        new Map(
          bounds.map((b) => {
            const next = this.#next.get(b.partition) ?? b.high;
            this.#next.set(b.partition, next);
            return [
              b.partition,
              next < b.low ? new Error("Tool command recovery exceeded Kafka retention") : next,
            ];
          }),
        ),
      handler: (record) => this.consume(record),
    });
    this.#sweeper = setInterval(() => {
      for (const [id, outcome] of this.#results)
        if (!this.#broker.ownsToolBinding(outcome.activationId)) {
          this.#release(id, "binding");
          this.#results.delete(id);
        }
      for (const [key, call] of this.#calls)
        if (!this.#broker.ownsToolBinding(call.activationId)) this.#calls.delete(key);
      for (const listeners of this.#waiters.values()) for (const wake of listeners) wake();
    }, 1000);
    this.#sweeper.unref();
  }

  async start(): Promise<void> {
    const heads = await this.#consumer.captureEndOffsets();
    await this.#consumer.start();
    await this.#consumer.waitUntilInitialReplay(heads);
  }
  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  async consume(record: KafkaLogRecord<LogFact>): Promise<void> {
    const fact = record.fact;
    this.#attemptWriters.set(fact.scope.attemptId, fact.scope.writerId);
    if (this.#attemptWriters.size > 65_536)
      this.#attemptWriters.delete(this.#attemptWriters.keys().next().value!);
    this.#consumed++;
    if (fact.kind === "execution_seal" || fact.kind === "execution_committed") {
      this.#sealed.add(fact.scope.attemptId);
      if (fact.closesWriter) this.#sealedWriters.add(fact.scope.writerId);
      if (this.#sealedWriters.size > 65_536)
        this.#sealedWriters.delete(this.#sealedWriters.values().next().value!);
      if (this.#sealed.size > 65_536) this.#sealed.delete(this.#sealed.values().next().value!);
      for (const [id, outcome] of this.#results)
        if (
          outcome.attemptId === fact.scope.attemptId ||
          (fact.closesWriter && outcome.writerId === fact.scope.writerId)
        ) {
          this.#release(id, "seal");
          this.#results.delete(id);
        }
      for (const [key, call] of this.#calls)
        if (
          call.attemptId === fact.scope.attemptId ||
          (fact.closesWriter && call.writerId === fact.scope.writerId)
        )
          this.#calls.delete(key);
    } else if (fact.kind === "pi_session_append") {
      // The trusted Harness co-publishes its native result and this platform
      // completion in ONE Fact. Standalone UI events are not delivery ACKs.
      // Broker need not know Pi Entry/Record/message internals.
      for (const event of fact.events ?? []) {
        if (event.type !== "tool.completed" || !event.payload.toolCallId) continue;
        const call = this.#calls.get(callKey(fact.scope, event.payload.toolCallId));
        if (!call) continue;
        call.closed = true;
        for (const id of call.operations) this.#release(id, "native_result");
      }
    } else if (fact.kind === "tool_command") {
      const command = fact as AcceptedToolCommand;
      if (this.#broker.ownsToolBinding(command.request.activationId)) this.#dispatch(command);
    }
    this.#next.set(record.partition, record.offset + 1n);
  }

  #dispatch(command: AcceptedToolCommand): void {
    const request = parseToolSandboxOperationRequest(command.request);
    const key = callKey(command.scope, command.toolCallId);
    const hash = createHash("sha256")
      .update(JSON.stringify([key, request]))
      .digest("hex");
    const existing = this.#results.get(request.operationId);
    if (existing) {
      if (existing.hash !== hash)
        throw new Error("Tool command ID reused with different arguments");
      return;
    }
    const call = this.#calls.get(key) ?? {
      activationId: request.activationId,
      attemptId: command.scope.attemptId,
      writerId: command.scope.writerId,
      operations: new Set<string>(),
      closed: false,
    };
    this.#calls.set(key, call);
    call.operations.add(request.operationId);
    const outcome: Outcome = {
      activationId: request.activationId,
      attemptId: command.scope.attemptId,
      writerId: command.scope.writerId,
      hash,
      retired: false,
      settled: false,
    };
    this.#results.set(request.operationId, outcome);
    this.#commands++;
    const parent = parseTraceCarrier(command.traceContext ?? {});
    const result = withSpan({
      serviceName: "pi-cloud-tool-broker",
      name: `tool.${request.operation}`,
      ...(parent ? { parent } : {}),
      attributes: {
        "pi_cloud.run.id": command.scope.runId,
        "pi_cloud.tool.operation_id": request.operationId,
      },
      run: async () => {
        if (this.#closed || this.#isSealed(command.scope.attemptId) || call.closed)
          throw new ToolBrokerError(
            "tool_command_sealed",
            "Tool command belongs to a closed execution",
            false,
          );
        if (this.#active >= this.#maximumActiveCommands) {
          this.#metrics?.toolTransportRejected.inc({ reason: "commands" });
          throw new ToolBrokerError(
            "tool_command_capacity_exhausted",
            "Tool command executor is at capacity",
            true,
          );
        }
        this.#active++;
        const started = performance.now();
        try {
          const result = await this.#broker.execute(
            createExecutionLease(
              command.scope.leaseId,
              command.scope.attemptId,
              command.scope.fencingToken,
            ),
            request,
          );
          this.#metrics?.toolDuration.observe(
            { tool: request.operation, outcome: "completed" },
            (performance.now() - started) / 1000,
          );
          return result;
        } catch (error) {
          this.#metrics?.toolDuration.observe(
            { tool: request.operation, outcome: "failed" },
            (performance.now() - started) / 1000,
          );
          throw error;
        } finally {
          this.#active--;
        }
      },
    }).then(
      (response) => {
        outcome.settled = true;
        // Wake existing deliveries before possibly evicting only their retry copy.
        this.#wake(request.operationId);
        if (outcome.retired || this.#closed) return response;
        if (!this.#broker.ownsToolBinding(outcome.activationId)) {
          this.#release(request.operationId, "binding");
          return response;
        }
        const bytes = Buffer.byteLength(JSON.stringify(response));
        this.#completed.set(request.operationId, bytes);
        this.#retainedBytes += bytes;
        // Retire only the retry copy. A reader already waiting on this Promise
        // may finish normally; later reads cannot restart the effect.
        while (this.#retainedBytes > this.#maximumResultBytes)
          this.#release(this.#completed.keys().next().value!, "capacity");
        this.#peakRetainedBytes = Math.max(this.#peakRetainedBytes, this.#retainedBytes);
        this.#metrics?.toolResultCacheBytes.set(this.#retainedBytes);
        return response;
      },
      (error: unknown) => {
        outcome.settled = true;
        this.#wake(request.operationId);
        throw error;
      },
    );
    void result.catch(() => undefined);
    outcome.result = result;
    this.#wake(request.operationId);
  }

  #wake(operationId: string): void {
    for (const wake of this.#waiters.get(operationId) ?? []) wake();
  }

  #release(
    id: string,
    reason: "native_result" | "seal" | "binding" | "capacity" | "shutdown",
  ): void {
    const outcome = this.#results.get(id);
    if (!outcome || outcome.retired) return;
    outcome.retired = true;
    delete outcome.result;
    this.#retainedBytes -= this.#completed.get(id) ?? 0;
    this.#completed.delete(id);
    this.#releasedResults++;
    this.#metrics?.toolResultCacheBytes.set(this.#retainedBytes);
    this.#metrics?.toolResultCacheReleased.inc({ reason });
    this.#wake(id);
  }

  async waitResult(
    executionLease: string,
    activationId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    this.#broker.assertToolResultReader(activationId, executionLease);
    signal?.throwIfAborted();
    const read = (): Outcome | undefined => {
      this.#broker.assertToolResultReader(activationId, executionLease);
      if (this.#isSealed(parseExecutionLease(executionLease).attemptId))
        throw new ToolBrokerError(
          "tool_command_sealed",
          "Tool command belongs to a closed execution",
          false,
        );
      const outcome = this.#results.get(operationId);
      if (outcome && outcome.activationId !== activationId)
        throw new ToolBrokerError(
          "tool_command_identity_mismatch",
          "Tool result belongs to another binding",
          false,
        );
      if (outcome?.retired)
        throw new ToolBrokerError(
          "tool_result_released",
          "Tool response is no longer retained; the operation must not be restarted",
          false,
        );
      return outcome;
    };
    const found = read();
    if (found?.settled) return found.result!;
    return new Promise<ToolSandboxOperationResponse>((resolve, reject) => {
      const finish = (error?: unknown, outcome?: Outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const listeners = this.#waiters.get(operationId);
        listeners?.delete(wake);
        if (!listeners?.size) this.#waiters.delete(operationId);
        if (error) reject(error);
        else if (outcome) resolve(outcome.result!);
      };
      const wake = () => {
        try {
          if (this.#closed)
            throw new ToolBrokerError(
              "tool_command_executor_closed",
              "Tool command executor stopped",
              false,
            );
          const outcome = read();
          if (outcome) clearTimeout(timer); // delivery occurred; the Tool owns its execution deadline
          if (outcome?.settled) finish(undefined, outcome);
        } catch (error) {
          finish(error);
        }
      };
      const abort = () => finish(signal?.reason ?? new Error("Tool result reader disconnected"));
      const timer = setTimeout(
        () =>
          finish(
            new ToolBrokerError(
              "tool_command_delivery_unknown",
              "Tool command delivery could not be confirmed",
              false,
            ),
          ),
        30_000,
      );
      timer.unref();
      const listeners = this.#waiters.get(operationId) ?? new Set();
      listeners.add(wake);
      this.#waiters.set(operationId, listeners);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else wake();
    });
  }
  #isSealed(attemptId: string) {
    const writerId = this.#attemptWriters.get(attemptId);
    return (
      this.#sealed.has(attemptId) || (writerId !== undefined && this.#sealedWriters.has(writerId))
    );
  }

  statistics() {
    return {
      consumedFacts: this.#consumed,
      acceptedCommands: this.#commands,
      activeCommands: this.#active,
      maximumActiveCommands: this.#maximumActiveCommands,
      waitingReaders: [...this.#waiters.values()].reduce((n, readers) => n + readers.size, 0),
      retainedResults: this.#completed.size,
      retainedResultBytes: this.#retainedBytes,
      peakRetainedResultBytes: this.#peakRetainedBytes,
      releasedResults: this.#releasedResults,
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweeper);
    for (const listeners of this.#waiters.values()) for (const wake of listeners) wake();
    await this.#consumer.close();
    for (const id of this.#results.keys()) this.#release(id, "shutdown");
    this.#results.clear();
    this.#calls.clear();
  }
}
