import {
  createExecutionReference,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
  type NativeToolEvent,
  type ToolProgressDelivery,
  TOOL_PROGRESS_MAX_CHARACTERS,
} from "@pi-cloud/protocol";
import {
  operationalLog,
  parseTraceCarrier,
  withSpan,
  type PiCloudMetrics,
} from "@pi-cloud/observability";
import { ToolBrokerError } from "./sandbox-provider.ts";
import type { ToolBroker } from "./tool-broker.ts";

export type ToolLogRecord<T> = Readonly<{
  fact: T;
  topic: string;
  partition: number;
  offset: bigint;
}>;
export type ToolLogFact = {
  kind: string;
  scope: Pick<AcceptedToolCommand["scope"], "runId" | "writerId"> &
    Partial<AcceptedToolCommand["scope"]>;
  closesWriter?: boolean;
};
type Reply = { operationId: string; sequence: number; event: NativeToolEvent };

/** Projector committed the dispatch boundary before delivery. No completed-result cache. */
export class ToolCommandExecutor {
  readonly #broker: Pick<ToolBroker, "execute" | "ownsToolBinding">;
  readonly #publishReply: (topic: string, reply: Reply) => Promise<void>;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #maximumActiveCommands: number;
  readonly #progress:
    { update(value: ToolProgressDelivery): void; forget(id: string): void } | undefined;
  readonly #positions = new Map<string, bigint>();
  readonly #sealed = new Set<string>();
  readonly #sealedWriters = new Set<string>();
  readonly #active = new Map<string, AcceptedToolCommand["scope"]>();
  #commands = 0;
  #closed = false;

  constructor(options: {
    broker: Pick<ToolBroker, "execute" | "ownsToolBinding">;
    publishReply: (topic: string, reply: Reply) => Promise<void>;
    maximumActiveCommands?: number;
    metrics?: PiCloudMetrics;
    progress?: { update(value: ToolProgressDelivery): void; forget(id: string): void };
  }) {
    this.#broker = options.broker;
    this.#publishReply = options.publishReply;
    this.#progress = options.progress;
    this.#maximumActiveCommands = options.maximumActiveCommands ?? 32;
    this.#metrics = options.metrics;
    if (!Number.isSafeInteger(this.#maximumActiveCommands) || this.#maximumActiveCommands < 1)
      throw new Error("Invalid Tool execution capacity");
  }
  checkHealth(): void {
    if (this.#closed) throw new Error("Tool command executor stopped");
  }
  receive(record: ToolLogRecord<ToolLogFact>): void {
    if (this.#closed) throw new Error("Tool command executor stopped");
    const key = `${record.topic}:${record.partition}`;
    if (record.offset <= (this.#positions.get(key) ?? -1n)) return;
    // Record synchronous admission before any asynchronous execution continuation.
    this.#positions.set(key, record.offset);
    this.consume(record);
  }
  consume(record: ToolLogRecord<ToolLogFact>): void {
    const { fact } = record;
    if (fact.kind === "execution_seal") {
      for (const [id, scope] of this.#active) {
        if (
          scope.runId === fact.scope.runId ||
          (fact.closesWriter && scope.writerId === fact.scope.writerId)
        )
          this.#progress?.forget(id);
      }
      this.#sealed.add(fact.scope.runId);
      if (fact.closesWriter) this.#sealedWriters.add(fact.scope.writerId);
      if (this.#sealed.size > 65536) this.#sealed.delete(this.#sealed.values().next().value!);
      if (this.#sealedWriters.size > 65536)
        this.#sealedWriters.delete(this.#sealedWriters.values().next().value!);
    } else if (fact.kind === "tool_command") {
      const command = fact as AcceptedToolCommand;
      if (this.#broker.ownsToolBinding(command.request.activationId))
        this.#dispatch(command, record.partition);
    }
  }
  #closedFor(command: AcceptedToolCommand): boolean {
    return (
      this.#closed ||
      this.#sealed.has(command.scope.runId) ||
      this.#sealedWriters.has(command.scope.writerId) ||
      !this.#broker.ownsToolBinding(command.request.activationId)
    );
  }
  #dispatch(command: AcceptedToolCommand, partition: number): void {
    const request = parseToolSandboxOperationRequest(command.request);
    if (request.operation !== "tool.execute" && request.operation !== "workflow.exec")
      throw new Error("WAL commands must execute whole Tools");
    if (this.#active.has(request.operationId) || this.#closedFor(command)) return;
    if (!command.replyTopic) throw new Error("Tool reply destination is unavailable");
    const topic = command.replyTopic;
    let sequence = 0,
      publicationFailure: unknown;
    let revision = 0;
    const send = async (event: NativeToolEvent) => {
      if (this.#closedFor(command) || publicationFailure) return;
      if (event.type === "tool_execution_update") {
        const text = event.partialResult.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .slice(-TOOL_PROGRESS_MAX_CHARACTERS);
        if (text)
          this.#progress?.update({
            tenantId: command.scope.tenantId,
            partition,
            progress: {
              type: "tool.progress",
              sessionId: command.scope.sessionId,
              turnId: command.scope.turnId,
              toolCallId: command.toolCallId,
              operationId: request.operationId,
              revision: ++revision,
              text,
            },
          });
        return;
      }
      try {
        await this.#publishReply(topic, {
          operationId: request.operationId,
          sequence: ++sequence,
          event,
        });
      } catch (error) {
        publicationFailure = error;
        // A reply transport failure is not evidence that the Cube has died.
        // Do not throw through the provider and destroy a healthy environment.
        this.#metrics?.toolTransportRejected.inc({ reason: "reply_publication" });
        operationalLog({
          service: "pi-cloud-tool-broker",
          level: "error",
          event: "tool.reply.failed",
          attributes: { runId: command.scope.runId, operationId: request.operationId },
        });
      }
    };
    const parent = parseTraceCarrier(command.traceContext ?? {});
    this.#commands++;
    const started = performance.now();
    void withSpan({
      serviceName: "pi-cloud-tool-broker",
      name: `tool.${request.operation}`,
      ...(parent ? { parent } : {}),
      attributes: {
        "pi_cloud.run.id": command.scope.runId,
        "pi_cloud.tool.operation_id": request.operationId,
      },
      run: async () => {
        if (this.#active.size >= this.#maximumActiveCommands)
          throw new ToolBrokerError(
            "tool_command_capacity_exhausted",
            "Tool executor is at capacity",
            false,
          );
        const response = await this.#broker.execute(
          createExecutionReference(
            command.scope.leaseId,
            command.scope.runId,
            command.scope.fencingToken,
          ),
          request,
          undefined,
          send,
        );
        if (response.type === "tool_sandbox.operation_failed")
          throw new ToolBrokerError(response.code, response.message, response.retryable);
        if (
          response.activationId !== request.activationId ||
          response.operationId !== request.operationId
        )
          throw new Error("Cube Tool result identity changed");
        if (response.operation === "tool.execute") {
          if (response.event.type !== "tool_execution_end")
            throw new Error("Tool ended without its native result");
          await send(response.event);
        } else if (response.operation === "workflow.exec") {
          await send({
            type: "tool_execution_end",
            toolCallId: command.toolCallId,
            toolName: request.toolName,
            isError: !response.ok,
            result: {
              content: response.ok
                ? []
                : [{ type: "text", text: response.error ?? "Workflow failed" }],
              details: response.value,
            },
          });
        } else throw new Error("WAL commands must execute whole Tools");
        this.#metrics?.toolDuration.observe(
          { tool: request.operation, outcome: "completed" },
          (performance.now() - started) / 1000,
        );
      },
    })
      .catch(async (error: unknown) => {
        this.#metrics?.toolDuration.observe(
          { tool: request.operation, outcome: "failed" },
          (performance.now() - started) / 1000,
        );
        const code =
          error instanceof ToolBrokerError ? error.code : "tool_operation_outcome_unknown";
        const message =
          error instanceof ToolBrokerError
            ? error.message
            : "Tool execution result could not be confirmed; do not automatically repeat the command";
        await send({
          type: "tool_execution_end",
          toolCallId: command.toolCallId,
          toolName: request.toolName,
          result: { content: [{ type: "text", text: `${code}: ${message}` }], details: undefined },
          isError: true,
        });
      })
      .finally(() => {
        this.#progress?.forget(request.operationId);
        this.#active.delete(request.operationId);
      });
    this.#active.set(request.operationId, command.scope);
  }
  statistics() {
    return {
      acceptedCommands: this.#commands,
      activeCommands: this.#active.size,
      maximumActiveCommands: this.#maximumActiveCommands,
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const id of this.#active.keys()) this.#progress?.forget(id);
  }
}
