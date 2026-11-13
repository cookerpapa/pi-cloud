import { type KafkaToolDispatchRecord } from "@pi-cloud/runtime-core/kafka-accepted-fact-consumer";
import {
  ExecutorTransportFailure,
  type ExecutorTransport,
} from "@pi-cloud/sandbox-control/executor-transport";
import { type ToolReply } from "@pi-cloud/event-log";
import { type AcceptedExecutorToolCommand } from "@pi-cloud/protocol";
import { ExecutionBindingView, executionBinding } from "./execution-target-service.ts";
import {
  executorToolBudget,
  type ToolCompletionGrant,
  type ToolCompletionDestination,
} from "@pi-cloud/protocol";

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
      completion: { issue(grant: ToolCompletionGrant): Promise<ToolCompletionDestination> };
      deviceCompletion?: { issue(grant: ToolCompletionGrant): Promise<ToolCompletionDestination> };
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
      const row = this.options.routes.getCancellation(
        fact.request.activationId,
        fact.scope,
        fact.request.originalWriterId,
      );
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
    let attempted = false;
    try {
      const issuer = new URL(row.endpoint).pathname.startsWith("/targets/")
        ? this.options.deviceCompletion
        : this.options.completion;
      if (!issuer)
        throw new ExecutorTransportFailure({
          code: "device_completion_unavailable",
          effect: "not_started",
          message:
            "Configure a reachable HTTPS completion endpoint before dispatching to outbound devices.",
        });
      const completion = await issuer.issue({
        operationId: fact.operationId,
        expiresAt: fact.replyRecovery.deadlineAt,
        context: {
          kind: "executor_tool",
          scope: fact.scope,
          replyTopic: fact.replyTopic,
          toolCallId: `task:${fact.taskId}`,
          nativeToolCallId: fact.nativeCallId,
          toolName: fact.toolName,
          partition: record.partition,
        },
      });
      if (!current()) return;
      attempted = true;
      await this.options.transport.submit(row.endpoint, {
        version: 2,
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
        completion,
        deadlineAt:
          Date.parse(fact.occurredAt) +
          executorToolBudget(fact.toolName, fact.arguments).operationMs,
      });
    } catch (error) {
      await this.#failure(
        fact,
        error instanceof ExecutorTransportFailure
          ? error.failure
          : {
              code: "executor_handoff_unconfirmed",
              effect: attempted ? "unknown" : "not_started",
              message: attempted
                ? "Device handoff was not confirmed. Inspect its state before repeating this operation."
                : "Device reply delivery was unavailable before execution admission; no action was sent.",
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
