import { createHash, randomUUID } from "node:crypto";
import { KafkaLogConsumer, type KafkaLogRecord } from "@pi-cloud/event-log";
import {
  createExecutionLease,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { ToolBrokerError } from "./sandbox-provider.ts";
import type { ToolBroker } from "./tool-broker.ts";
import { parseTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";

type LogFact = { kind: string; scope: { attemptId: string } };
type Outcome = {
  activationId: string;
  attemptId: string;
  hash: string;
  result: Promise<ToolSandboxOperationResponse>;
};
type CommandBroker = Pick<ToolBroker, "execute" | "ownsToolBinding" | "assertToolResultReader">;

/** Boot-local bindings do not survive a Broker failure. Kafka reconnect can
 * redeliver within this boot; a new boot must never auto-replay an old effect. */
export class KafkaToolCommandConsumer {
  readonly #broker: CommandBroker;
  readonly #consumer: KafkaLogConsumer<LogFact>;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #next = new Map<number, bigint>();
  readonly #sealed = new Set<string>();
  readonly #results = new Map<string, Outcome>();
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
  }) {
    this.#broker = options.broker;
    this.#metrics = options.metrics;
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
        if (!this.#broker.ownsToolBinding(outcome.activationId)) this.#results.delete(id);
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
    this.#consumed++;
    if (fact.kind === "execution_seal" || fact.kind === "execution_committed") {
      this.#sealed.add(fact.scope.attemptId);
      if (this.#sealed.size > 65_536) this.#sealed.delete(this.#sealed.values().next().value!);
      for (const [id, outcome] of this.#results)
        if (outcome.attemptId === fact.scope.attemptId) this.#results.delete(id);
    } else if (fact.kind === "tool_command") {
      const command = fact as AcceptedToolCommand;
      if (this.#broker.ownsToolBinding(command.request.activationId)) this.#dispatch(command);
    }
    this.#next.set(record.partition, record.offset + 1n);
  }

  #dispatch(command: AcceptedToolCommand): void {
    const request = parseToolSandboxOperationRequest(command.request);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.#results.get(request.operationId);
    if (existing) {
      if (existing.hash !== hash)
        throw new Error("Tool command ID reused with different arguments");
      return;
    }
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
        if (this.#closed || this.#sealed.has(command.scope.attemptId))
          throw new ToolBrokerError(
            "tool_command_sealed",
            "Tool command belongs to a closed execution",
            false,
          );
        if (this.#active >= 1024)
          throw new ToolBrokerError(
            "tool_command_capacity_exhausted",
            "Tool command executor is at capacity",
            true,
          );
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
    });
    void result.catch(() => undefined);
    this.#results.set(request.operationId, {
      activationId: request.activationId,
      attemptId: command.scope.attemptId,
      hash,
      result,
    });
    for (const wake of this.#waiters.get(request.operationId) ?? []) wake();
  }

  async waitResult(
    executionLease: string,
    activationId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    this.#broker.assertToolResultReader(activationId, executionLease);
    const read = (): Outcome | undefined => {
      this.#broker.assertToolResultReader(activationId, executionLease);
      const outcome = this.#results.get(operationId);
      if (outcome && outcome.activationId !== activationId)
        throw new ToolBrokerError(
          "tool_command_identity_mismatch",
          "Tool result belongs to another binding",
          false,
        );
      return outcome;
    };
    const found = read();
    if (found) return found.result;
    if (this.#waiters.size >= 1024)
      throw new ToolBrokerError(
        "tool_result_capacity_exhausted",
        "Tool result readers are at capacity",
        true,
      );
    return new Promise<ToolSandboxOperationResponse>((resolve, reject) => {
      const finish = (error?: unknown, outcome?: Outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const listeners = this.#waiters.get(operationId);
        listeners?.delete(wake);
        if (!listeners?.size) this.#waiters.delete(operationId);
        if (error) reject(error);
        else if (outcome) resolve(outcome.result);
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
          if (outcome) finish(undefined, outcome);
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

  statistics() {
    return {
      consumedFacts: this.#consumed,
      acceptedCommands: this.#commands,
      activeCommands: this.#active,
      retainedResults: this.#results.size,
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweeper);
    for (const listeners of this.#waiters.values()) for (const wake of listeners) wake();
    await this.#consumer.close();
    this.#results.clear();
  }
}
