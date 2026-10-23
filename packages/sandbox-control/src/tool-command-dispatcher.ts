import {
  MAX_IMAGE_GUEST_RESPONSE_BYTES,
  parseExecutionReference,
  type AcceptedToolCommand,
  type ExecutionLogPosition,
  type SandboxBindingChange,
  type AcceptedToolCancellation,
  type ToolExecutionFailureData,
} from "@pi-cloud/protocol";
import type { ToolReply } from "@pi-cloud/event-log";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { Agent, fetch as internalFetch } from "undici";
import {
  CubeExecutionRejected,
  CubeRuntimeTransportError,
  CubeRuntimeClientError,
  type CubeSandboxRuntimeClient,
} from "./cubesandbox-runtime-client.ts";
import type { ToolLogFact, ToolLogRecord } from "./workflow-command-dispatcher.ts";
import type { SandboxBinding, SandboxBindingReader } from "./sandbox-bindings.ts";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";
import { executionTargetId } from "./sandbox-execution.ts";

export const WORKFLOW_LOG_DELIVERY_PATH = "/internal/v1/workflow-log-delivery";
export type ToolLogDelivery = Readonly<{
  instanceId: string;
  topic: string;
  partition: number;
  offset: string;
  fact: ToolLogFact;
}>;
export function toolDeliveryFact(fact: ToolLogFact): ToolLogFact | undefined {
  if (fact.kind === "tool_command") return fact;
  if (fact.kind === "tool_cancel") return fact;
  if (fact.kind === "execution_seal" || fact.kind === "work_finished")
    return {
      kind: "execution_seal",
      scope: fact.scope,
    };
  return undefined;
}

type WorkflowDelivery = ((
  route: Pick<SandboxBinding, "instanceId" | "baseUrl">,
  delivery: ToolLogDelivery,
) => Promise<void>) & { close?(): Promise<void> };

function handoffFailure(error: unknown): {
  failure: ToolExecutionFailureData;
  quarantine: boolean;
} {
  let code = "cubesandbox_tool_result_unknown";
  let effect: ToolExecutionFailureData["effect"] = "unknown";
  let quarantine = false;
  if (
    error instanceof CubeRuntimeTransportError ||
    (error instanceof CubeRuntimeClientError &&
      error.statusCode !== undefined &&
      (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500))
  )
    code = "tool_handoff_unconfirmed";
  if (error instanceof CubeExecutionRejected) {
    switch (error.code) {
      case "executor_replaced":
      case "runtime_quarantined":
        code = "cubesandbox_tool_unavailable";
        quarantine = true;
        break;
      case "node_unavailable":
      case "execution_unavailable":
      case "runtime_retention_unavailable":
      case "execution_endpoint_unconfigured":
      case "executor_capacity":
        code = "cubesandbox_tool_unavailable";
        effect = "not_started";
        break;
      case "capacity":
      case "invalid_request":
      case "invalid_identity":
      case "invalid_execution_position":
        code = "tool_execution_not_started";
        effect = "not_started";
        break;
      // A stale position/changed identity may describe an earlier effect.
      // Unrecognized refusal semantics likewise cannot prove non-execution.
    }
  }
  return {
    quarantine,
    failure: {
      code,
      effect,
      message:
        effect === "not_started"
          ? "The execution request was refused before admission; this delivery did not start a file or shell action."
          : "Execution handoff did not return a confirmed result. The operation may have executed or may still be running. It was not replayed; inspect effects before deciding to repeat it.",
    },
  };
}

/** Runs after the Projector's durable dispatch commit. Fixed Tools go straight
 * to Cube's native executor; only interactive workflow channels use their owner. */
export class ToolCommandDispatcher {
  #consumed = 0;
  #delivered = 0;
  #abandoned = 0;
  constructor(
    readonly options: {
      routes: SandboxBindingReader;
      cube: Pick<CubeSandboxRuntimeClient, "submitTool" | "cancelTool">;
      workflow: WorkflowDelivery;
      publishReply(
        topic: string,
        reply: ToolReply,
        scope: AcceptedToolCommand["scope"],
      ): Promise<void>;
      quarantine(target: SandboxExecutionTarget): Promise<void>;
      onDispatch?(command: AcceptedToolCommand, route: SandboxBinding): void;
      metrics?: PiCloudMetrics;
    },
  ) {}

  async consume(record: ToolLogRecord<ToolLogFact>, current?: () => boolean): Promise<void> {
    this.#consumed++;
    const fact = toolDeliveryFact(record.fact);
    this.options.metrics?.toolLogConsumed.inc({ kind: fact?.kind ?? "ignored" });
    if (!fact) return;
    const seal = fact.kind === "execution_seal";
    if (seal) {
      const terminal = (record.fact as { terminal?: { type: string } }).terminal;
      await this.options.routes.closeWriter(
        fact.scope,
        record.fact.kind === "execution_seal" || terminal?.type !== "turn.completed",
      );
      return;
    }
    const invocation = fact as AcceptedToolCommand | AcceptedToolCancellation;
    const route = await this.options.routes.get(fact.scope, invocation.request.activationId);
    if (current?.() === false) return;
    const source = {
      topic: record.topic,
      partition: record.partition,
      offset: record.offset.toString(),
    };
    if (fact.kind === "tool_cancel") {
      const cancel = fact as AcceptedToolCancellation;
      if (route)
        await this.#cancel(
          route.descriptor.target,
          {
            source,
            executionScopeId: route.bindingId,
            writerId: cancel.scope.writerId,
            operationId: cancel.request.operationId,
          },
          current,
        );
      return;
    }
    const command = fact as AcceptedToolCommand;
    if (!route || route.dispatchClosed) {
      await this.#fail(command, {
        code: "cubesandbox_tool_unavailable",
        message: "The recorded Tool binding is unavailable.",
        effect: "not_started",
      });
      return;
    }
    const started = performance.now();
    try {
      if (command.request.operation === "workflow.exec") {
        await this.options.workflow(route, {
          instanceId: route.instanceId,
          topic: record.topic,
          partition: record.partition,
          offset: record.offset.toString(),
          fact,
        });
      } else {
        try {
          this.options.onDispatch?.(command, route);
        } catch {
          /* Observation only. */
        }
        await this.options.cube.submitTool(route.descriptor.target, {
          source,
          operationId: command.request.operationId,
          executionScopeId: route.bindingId,
          writerId: command.scope.writerId,
          payload: {
            toolWorkerProtocolVersion: 7,
            type: "worker.operation",
            attachment: route.descriptor.attachment,
            request: command.request,
          },
          completionContext: {
            execution: {
              bindingId: route.bindingId,
              targetId: executionTargetId(route.descriptor.target),
              bootId: route.descriptor.target.bootId,
            },
            scope: command.scope,
            replyTopic: command.replyTopic,
            toolCallId: command.toolCallId,
            nativeToolCallId: command.request.toolCallId,
            toolName: command.request.toolName,
            partition: record.partition,
          },
          timeoutMs: command.request.timeoutMs + 5000,
          maximumOutputBytes:
            command.request.toolName === "read" ? MAX_IMAGE_GUEST_RESPONSE_BYTES : 8 * 1024 * 1024,
        });
      }
      this.#delivered++;
    } catch (error) {
      this.#abandoned++;
      const outcome = handoffFailure(error);
      // A lost handoff response cannot retract an accepted external effect.
      // Do not compensate by stopping processes or replaying the command.
      // Notify the original Worker without waiting for lifecycle propagation.
      // Join both branches so shutdown/rebalance never abandons quarantine work.
      const settled = await Promise.allSettled([
        this.#fail(command, outcome.failure),
        ...(outcome.quarantine
          ? [Promise.resolve().then(() => this.options.quarantine(route.descriptor.target))]
          : []),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "Tool failure settlement is incomplete");
    } finally {
      this.options.metrics?.toolLogDelivery.observe(
        { route: "local", outcome: "handoff" },
        (performance.now() - started) / 1000,
      );
    }
  }
  async cancelRetiredBinding(
    change: SandboxBindingChange,
    source: ExecutionLogPosition,
    current: () => boolean,
  ): Promise<void> {
    if (!change.closed || !change.cancelTarget || !current()) return;
    const { writerId, ...target } = change.cancelTarget;
    await this.#cancel(target, { source, executionScopeId: change.entityId, writerId }, current);
  }
  async #cancel(
    target: SandboxExecutionTarget,
    request: Parameters<CubeSandboxRuntimeClient["cancelTool"]>[1],
    current?: () => boolean,
  ): Promise<void> {
    // Bound one partition's wait; the Worker independently bounds result
    // settlement. Retry only cancellation, never the original shell command.
    for (let attempt = 0; attempt < 2 && current?.() !== false; attempt++) {
      try {
        await this.options.cube.cancelTool(target, request);
        return;
      } catch (error) {
        if (error instanceof CubeExecutionRejected) break;
      }
    }
    operationalLog({
      service: "pi-cloud-control-plane",
      level: "warn",
      event: "tool.cancellation.unconfirmed",
      attributes: {
        bindingId: request.executionScopeId,
        ...(request.operationId ? { operationId: request.operationId } : {}),
      },
    });
  }
  /** Close interactive Agent orchestration, never accepted fixed Tool processes. */
  async closeWorkflowBinding(
    change: SandboxBindingChange,
    route: SandboxBinding,
    source: ExecutionLogPosition,
    current: () => boolean,
  ): Promise<void> {
    if (!change.closed || !route.dispatchClosed) throw new Error("Binding is not closed");
    if (!current()) throw new Error("Binding closure owner changed");
    try {
      await this.options.workflow(route, {
        ...source,
        instanceId: route.instanceId,
        fact: {
          kind: "binding_close",
          bindingId: route.bindingId,
          scope: {
            tenantId: change.scope.tenantId,
            runId: change.runId,
            writerId: parseExecutionReference(route.snapshot.assignment.executionReference).leaseId,
          },
        },
      });
    } catch {
      if (await this.options.routes.isAlive(route.instanceId))
        throw new Error("Workflow closure is unconfirmed");
    }
  }
  async #fail(command: AcceptedToolCommand, failure: ToolExecutionFailureData): Promise<void> {
    if (!command.replyTopic) return;
    try {
      await this.options.publishReply(
        command.replyTopic,
        {
          operationId: command.request.operationId,
          sequence: 1,
          kind: "execution_failure",
          toolCallId:
            command.request.operation === "tool.execute"
              ? command.request.toolCallId
              : command.toolCallId,
          toolName: command.request.toolName,
          failure,
        },
        command.scope,
      );
    } catch {
      operationalLog({
        service: "pi-cloud-control-plane",
        level: "error",
        event: "tool.handoff_failure_reply_lost",
        attributes: { operationId: command.request.operationId },
      });
    }
  }
  statistics() {
    return {
      consumedFacts: this.#consumed,
      deliveredRecords: this.#delivered,
      abandonedDeliveries: this.#abandoned,
    };
  }
  async close(): Promise<void> {
    await this.options.workflow.close?.();
  }
}

export function httpToolLogDelivery(token: string): WorkflowDelivery & { close(): Promise<void> } {
  const dispatcher = new Agent();
  const deliver: WorkflowDelivery = async (route, delivery) => {
    const response = await internalFetch(new URL(WORKFLOW_LOG_DELIVERY_PATH, route.baseUrl), {
      dispatcher,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(delivery),
      signal: AbortSignal.timeout(delivery.fact.kind === "execution_seal" ? 20000 : 5000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Workflow delivery failed: HTTP ${response.status}`);
  };
  return Object.assign(deliver, { close: () => dispatcher.destroy() });
}
