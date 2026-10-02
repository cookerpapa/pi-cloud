import {
  MAX_IMAGE_GUEST_RESPONSE_BYTES,
  type AcceptedToolCommand,
  type NativeToolEnd,
} from "@pi-cloud/protocol";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { Agent, fetch as internalFetch } from "undici";
import {
  CubeExecutionRejected,
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
  if (fact.kind === "execution_seal")
    return { kind: fact.kind, scope: fact.scope, closesWriter: fact.closesWriter === true };
  return undefined;
}

type WorkflowDelivery = ((
  route: Pick<SandboxBinding, "instanceId" | "baseUrl">,
  delivery: ToolLogDelivery,
) => Promise<void>) & { close?(): Promise<void> };

/** Runs after the Projector's durable dispatch commit. Fixed Tools go straight
 * to Cube's native executor; only interactive workflow channels use their owner. */
export class ToolCommandDispatcher {
  #consumed = 0;
  #delivered = 0;
  #abandoned = 0;
  constructor(
    readonly options: {
      routes: SandboxBindingReader;
      cube: Pick<CubeSandboxRuntimeClient, "submitTool" | "stopExecutionScope">;
      workflow: WorkflowDelivery;
      publishReply(
        topic: string,
        reply: { operationId: string; sequence: 1; event: NativeToolEnd },
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
    if (seal) await this.options.routes.closeScope(fact.scope, fact.closesWriter === true);
    // The partition view receives current closure at control publication
    // admission. Normal routing is in memory; Cube still fences in-flight work.
    const routes = await this.options.routes.find(fact.scope, seal && fact.closesWriter === true);
    if (current?.() === false) return;
    if (seal) {
      const targets = new Map(
        routes.map((r) => [JSON.stringify(r.descriptor.target), r.descriptor.target]),
      );
      const fixed = Promise.all(
        [...targets.values()].map(async (target) => {
          if (current?.() === false) return;
          try {
            await this.options.cube.stopExecutionScope(
              target,
              fact.closesWriter ? { writerId: fact.scope.writerId } : { runId: fact.scope.runId },
            );
          } catch {
            await this.options.quarantine(target);
          }
        }),
      );
      // Workflow hostcalls are tied to the control-plane owner's live duplex.
      const workflows = Promise.all(
        [...new Map(routes.map((r) => [r.instanceId, r])).values()].map(async (route) => {
          if (current?.() === false) return;
          try {
            await this.options.workflow(route, {
              instanceId: route.instanceId,
              topic: record.topic,
              partition: record.partition,
              offset: record.offset.toString(),
              fact,
            });
          } catch {
            if (await this.options.routes.isAlive(route.instanceId))
              throw new Error("Workflow closure is unconfirmed");
          }
        }),
      );
      await Promise.all([fixed, workflows]);
      return;
    }
    const command = fact as AcceptedToolCommand;
    const route = routes.find((r) => r.bindingId === command.request.activationId);
    if (!route || route.dispatchClosed) {
      await this.#fail(
        command,
        "cubesandbox_tool_unavailable",
        "The recorded Tool binding is unavailable.",
      );
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
          operationId: command.request.operationId,
          runId: command.scope.runId,
          writerId: command.scope.writerId,
          payload: {
            mode: "operation",
            initialization: route.descriptor.initialization,
            operation: command.request,
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
      let code = "cubesandbox_tool_result_unknown";
      if (!(error instanceof CubeExecutionRejected)) {
        try {
          await this.options.cube.stopExecutionScope(route.descriptor.target, {
            operationId: command.request.operationId,
          });
        } catch {
          await this.options.quarantine(route.descriptor.target);
          code = "cubesandbox_tool_unavailable";
        }
      } else if (["executor_replaced", "runtime_quarantined"].includes(error.code)) {
        await this.options.quarantine(route.descriptor.target);
        code = "cubesandbox_tool_unavailable";
      } else
        code =
          error.code === "operation_changed"
            ? "cubesandbox_tool_result_unknown"
            : error.code === "scope_closed"
              ? "tool_command_sealed"
              : [
                    "node_unavailable",
                    "execution_unavailable",
                    "execution_endpoint_unconfigured",
                    "executor_capacity",
                  ].includes(error.code)
                ? "cubesandbox_tool_unavailable"
                : "tool_execution_not_started";
      await this.#fail(
        command,
        code,
        "Execution handoff did not return a confirmed result. The operation was not replayed; inspect effects before repeating it.",
      );
    } finally {
      this.options.metrics?.toolLogDelivery.observe(
        { route: "local", outcome: "handoff" },
        (performance.now() - started) / 1000,
      );
    }
  }
  async #fail(command: AcceptedToolCommand, code: string, text: string): Promise<void> {
    if (!command.replyTopic) return;
    try {
      await this.options.publishReply(
        command.replyTopic,
        {
          operationId: command.request.operationId,
          sequence: 1,
          event: {
            type: "tool_execution_end",
            toolCallId:
              command.request.operation === "tool.execute"
                ? command.request.toolCallId
                : command.toolCallId,
            toolName: command.request.toolName,
            isError: true,
            result: { content: [{ type: "text", text: `${code}: ${text}` }], details: undefined },
          },
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
