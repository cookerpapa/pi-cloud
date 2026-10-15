import type { ToolReply } from "@pi-cloud/event-log";
import {
  createExecutionReference,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
  type NativeToolEvent,
  type ToolResultPayload,
  type ToolProgressDelivery,
  TOOL_PROGRESS_MAX_CHARACTERS,
  serializeSubagentResult,
} from "@pi-cloud/protocol";
import {
  operationalLog,
  parseTraceCarrier,
  withSpan,
  type PiCloudMetrics,
} from "@pi-cloud/observability";
import { SandboxControlError } from "./sandbox-provider.ts";
import type { SandboxController } from "./sandbox-controller.ts";

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
  bindingId?: string;
};
type Reply =
  | { kind: "tool_result"; operationId: string; sequence: 1; result: ToolResultPayload }
  | Extract<ToolReply, { kind: "execution_failure" }>;

/** Projector committed the dispatch boundary before delivery. No completed-result cache. */
export class WorkflowCommandDispatcher {
  readonly #broker: Pick<SandboxController, "executeWorkflow" | "ownsToolBinding">;
  readonly #publishReply: (
    topic: string,
    reply: Reply,
    scope: AcceptedToolCommand["scope"],
  ) => Promise<void>;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #maximumActiveCommands: number;
  readonly #progress:
    { update(value: ToolProgressDelivery): void; forget(id: string): void } | undefined;
  readonly #positions = new Map<string, { offset: bigint; deliveries: Set<string> }>();
  readonly #closedBindings = new Set<string>();
  readonly #sealedWriters = new Set<string>();
  readonly #active = new Map<string, { scope: AcceptedToolCommand["scope"]; bindingId: string }>();
  #commands = 0;
  #closed = false;

  constructor(options: {
    broker: Pick<SandboxController, "executeWorkflow" | "ownsToolBinding">;
    publishReply: (
      topic: string,
      reply: Reply,
      scope: AcceptedToolCommand["scope"],
    ) => Promise<void>;
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
    let position = this.#positions.get(key);
    if (position && record.offset < position.offset) return;
    if (!position || record.offset > position.offset) {
      position = { offset: record.offset, deliveries: new Set() };
      this.#positions.set(key, position);
    }
    const identity =
      record.fact.kind === "tool_command"
        ? (record.fact as AcceptedToolCommand).request.operationId
        : `${record.fact.kind}:${record.fact.scope.writerId}:${record.fact.bindingId ?? record.fact.scope.runId}`;
    if (position.deliveries.has(identity)) return;
    // Record synchronous admission before any asynchronous execution continuation.
    position.deliveries.add(identity);
    this.consume(record);
  }
  consume(record: ToolLogRecord<ToolLogFact>): void {
    const { fact } = record;
    if (fact.kind === "binding_close") {
      if (!fact.bindingId) throw new Error("Workflow binding closure needs its binding identity");
      this.#closedBindings.add(fact.bindingId);
      for (const [id, active] of this.#active)
        if (active.bindingId === fact.bindingId) this.#progress?.forget(id);
      if (this.#closedBindings.size > 65536)
        this.#closedBindings.delete(this.#closedBindings.values().next().value!);
    } else if (fact.kind === "execution_seal") {
      for (const [id, { scope }] of this.#active) {
        if (scope.writerId === fact.scope.writerId) this.#progress?.forget(id);
      }
      this.#sealedWriters.add(fact.scope.writerId);
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
      this.#closedBindings.has(command.request.activationId) ||
      this.#sealedWriters.has(command.scope.writerId) ||
      !this.#broker.ownsToolBinding(command.request.activationId)
    );
  }
  #dispatch(command: AcceptedToolCommand, partition: number): void {
    const request = parseToolSandboxOperationRequest(command.request);
    if (request.operation !== "workflow.exec")
      throw new Error("Fixed Tools require native Cube handoff");
    if (this.#active.has(request.operationId) || this.#closedFor(command)) return;
    if (!command.replyTopic) throw new Error("Tool reply destination is unavailable");
    const topic = command.replyTopic;
    let publicationFailure: unknown;
    let revision = 0;
    const publish = async (reply: Reply) => {
      if (this.#closedFor(command) || publicationFailure) return;
      try {
        await this.#publishReply(topic, reply, command.scope);
      } catch (error) {
        publicationFailure = error;
        // A reply transport failure is not evidence that the Cube has died.
        // Do not throw through the provider and destroy a healthy environment.
        this.#metrics?.toolTransportRejected.inc({ reason: "reply_publication" });
        operationalLog({
          service: "pi-cloud-sandbox-control",
          level: "error",
          event: "tool.reply.failed",
          attributes: { runId: command.scope.runId, operationId: request.operationId },
        });
      }
    };
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
      const { type: _nativeType, ...result } = event;
      await publish({ kind: "tool_result", operationId: request.operationId, sequence: 1, result });
    };
    const parent = parseTraceCarrier(command.traceContext ?? {});
    this.#commands++;
    const started = performance.now();
    void withSpan({
      serviceName: "pi-cloud-sandbox-control",
      name: `tool.${request.operation}`,
      ...(parent ? { parent } : {}),
      attributes: {
        "pi_cloud.run.id": command.scope.runId,
        "pi_cloud.tool.operation_id": request.operationId,
      },
      run: async () => {
        if (this.#active.size >= this.#maximumActiveCommands)
          throw new SandboxControlError(
            "tool_command_capacity_exhausted",
            "Tool executor is at capacity",
            false,
          );
        const response = await this.#broker.executeWorkflow(
          createExecutionReference(
            command.scope.writerId,
            command.scope.runId,
            command.scope.fencingToken,
          ),
          request,
          undefined,
          send,
        );
        if (response.type === "tool_sandbox.operation_failed")
          throw new SandboxControlError(response.code, response.message, response.retryable);
        if (
          response.activationId !== request.activationId ||
          response.operationId !== request.operationId
        )
          throw new Error("Cube Tool result identity changed");
        if (response.operation === "workflow.exec") {
          await send({
            type: "tool_execution_end",
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            isError: !response.ok,
            result: {
              content: response.ok
                ? [{ type: "text", text: serializeSubagentResult(response.value) }]
                : [{ type: "text", text: response.error ?? "Workflow failed" }],
              details: { action: "workflow" },
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
          error instanceof SandboxControlError ? error.code : "tool_operation_outcome_unknown";
        const message =
          error instanceof SandboxControlError
            ? error.message
            : "Tool execution result could not be confirmed; do not automatically repeat the command";
        await publish({
          kind: "execution_failure",
          operationId: request.operationId,
          sequence: 1,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          failure: {
            code,
            message: message.slice(0, 4096),
            effect: code === "tool_command_capacity_exhausted" ? "not_started" : "unknown",
          },
        });
      })
      .finally(() => {
        this.#progress?.forget(request.operationId);
        this.#active.delete(request.operationId);
      });
    this.#active.set(request.operationId, {
      scope: command.scope,
      bindingId: request.activationId,
    });
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
