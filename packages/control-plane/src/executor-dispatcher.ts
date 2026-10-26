import { type KafkaToolDispatchRecord } from "@pi-cloud/runtime-core/kafka-accepted-fact-consumer";
import { ExecutorTransportFailure, type ExecutorTransport } from "@pi-cloud/sandbox-control";
import { type ToolReply } from "@pi-cloud/event-log";
import { type AcceptedExecutorToolCommand } from "@pi-cloud/protocol";
import { ExecutionBindingView, executionBinding } from "./execution-target-service.ts";

/** Shared consumer/dispatch boundary, with provider-specific execution adapters.
 * This dispatcher never owns an Android UI action or a second command queue. */
export class ExecutorDispatcher {
  constructor(
    readonly options: {
      cube: {
        consume(record: KafkaToolDispatchRecord, current?: () => boolean): Promise<void>;
        close?(): Promise<void>;
      };
      routes: ExecutionBindingView;
      transport: ExecutorTransport;
      publish(topic: string, reply: ToolReply): Promise<void>;
    },
  ) {}
  async consume(
    record: KafkaToolDispatchRecord,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (!current()) return;
    const fact = record.fact;
    if (fact.kind === "execution_seal" || fact.kind === "work_finished") {
      await this.options.routes.closeWriter(fact.scope);
      await this.options.cube.consume(record, current);
      return;
    }
    if (fact.kind === "tool_cancel" && fact.request.target === "executor") {
      const row = this.options.routes.get(fact.request.activationId, fact.scope);
      if (!row) return;
      try {
        await this.options.transport.cancel(row.endpoint, {
          binding: executionBinding(row),
          operationId: fact.request.operationId,
          position: {
            topic: record.topic,
            partition: record.partition,
            offset: record.offset.toString(),
            index: 0,
          },
        });
      } catch {
        /* Native Stop does not claim physical undo. */
      }
      return;
    }
    if (fact.kind !== "executor_tool") {
      await this.options.cube.consume(record, current);
      return;
    }
    const row = this.options.routes.get(fact.bindingId, fact.scope);
    if (!row || row.conversation_id !== String(fact.conversationId)) {
      await this.#failure(fact, {
        code: "executor_binding_unavailable",
        effect: "not_started",
        message:
          "The recorded device binding is no longer available. This delivery was not started.",
      });
      return;
    }
    try {
      if (!current()) return;
      await this.options.transport.submit(row.endpoint, {
        version: 1,
        binding: executionBinding(row),
        position: {
          topic: record.topic,
          partition: record.partition,
          offset: record.offset.toString(),
          index: fact.operationIndex,
        },
        operationId: fact.operationId,
        toolName: fact.toolName,
        nativeCallId: fact.nativeCallId,
        arguments: fact.arguments,
        replyTopic: fact.replyTopic,
      });
    } catch (error) {
      await this.#failure(
        fact,
        error instanceof ExecutorTransportFailure
          ? error.failure
          : {
              code: "executor_handoff_unconfirmed",
              effect: "unknown",
              message:
                "Device handoff was not confirmed. Inspect its state before repeating this operation.",
            },
      );
    }
  }
  #failure(
    call: AcceptedExecutorToolCommand,
    failure: import("@pi-cloud/protocol").ToolExecutionFailureData,
  ) {
    return this.options.publish(call.replyTopic, {
      kind: "execution_failure",
      operationId: call.operationId,
      sequence: 1,
      toolName: call.toolName,
      toolCallId: call.nativeCallId,
      failure,
    });
  }
  async close() {
    await this.options.cube.close?.();
  }
}
