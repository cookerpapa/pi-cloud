import {
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
import type { SandboxToolExecutor, ToolExecutionCancellation } from "./tool-executor.ts";
import type { ToolEnvironmentCoordinator } from "./tool-environment-coordinator.ts";
import type { ToolLogFact, ToolLogRecord } from "./workflow-command-dispatcher.ts";
import type { SandboxBinding, SandboxBindingReader } from "./sandbox-bindings.ts";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";

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

/** Runs after the Projector's durable dispatch commit. Fixed Tools go straight
 * to their provider executor; interactive workflow channels use their owner. */
export class ToolCommandDispatcher {
  readonly #preparing = new Map<
    string,
    {
      bindingId: string;
      command: AcceptedToolCommand;
      controller: AbortController;
      result: Promise<void>;
    }
  >();
  readonly #resourceTails = new Map<string, { partition: number; result: Promise<void> }>();
  readonly #partitionBarriers = new Map<number, Promise<void>>();
  #generation = 0;

  #resourceKey(
    partition: number,
    target: Pick<
      import("@pi-cloud/protocol").ToolEnvironmentRequest,
      "assignment" | "computeSessionId"
    >,
  ): string {
    // Different bindings can share one VM. Cube fences VM/partition positions,
    // so only serializing per binding would allow a later handoff to overtake it.
    return JSON.stringify([
      partition,
      target.assignment.tenantId,
      target.assignment.workspaceId,
      target.computeSessionId ?? null,
    ]);
  }
  #current(current?: () => boolean): () => boolean {
    const generation = this.#generation;
    return () => generation === this.#generation && current?.() !== false;
  }
  #enqueue(partition: number, key: string | undefined, action: () => Promise<void>) {
    const barrier = this.#partitionBarriers.get(partition);
    const tails =
      key === undefined
        ? [...this.#resourceTails.values()].filter((t) => t.partition === partition)
        : [this.#resourceTails.get(key)].filter((t) => t !== undefined);
    const dependencies = [...(barrier ? [barrier] : []), ...tails.map((t) => t.result)];
    const result = Promise.allSettled(dependencies).then(action);
    if (key === undefined) this.#partitionBarriers.set(partition, result);
    else this.#resourceTails.set(key, { partition, result });
    void result
      .finally(() => {
        if (key === undefined) {
          if (this.#partitionBarriers.get(partition) === result)
            this.#partitionBarriers.delete(partition);
        } else if (this.#resourceTails.get(key)?.result === result) this.#resourceTails.delete(key);
      })
      .catch(() => {});
    // Only handoffs are queued, never process lifetimes. The Kafka handler must
    // remain free to apply the binding updates these preparations await.
    return { result, queued: dependencies.length > 0 };
  }
  #consumed = 0;
  #delivered = 0;
  #abandoned = 0;
  constructor(
    readonly options: {
      routes: SandboxBindingReader;
      executor: SandboxToolExecutor;
      environments?: Pick<ToolEnvironmentCoordinator, "ensure" | "retireWriter">;
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

  async consume(record: ToolLogRecord<ToolLogFact>, isCurrent?: () => boolean): Promise<void> {
    const current = this.#current(isCurrent);
    const command = record.fact as AcceptedToolCommand;
    if (command.kind === "tool_command") {
      const key = command.request.operationId;
      if (this.#preparing.has(key)) return;
      if (this.#preparing.size >= 4096) {
        await this.#fail(command, {
          code: "tool_execution_not_started",
          effect: "not_started",
          message: "Execution preparation is at capacity; this Tool was not submitted.",
        });
        return;
      }
      const bindingId = command.request.activationId;
      const known =
        command.environment ?? (await this.options.routes.get(command.scope, bindingId))?.snapshot;
      const resource = known ? this.#resourceKey(record.partition, known) : undefined;
      const controller = new AbortController();
      const active = () => current() && !controller.signal.aborted;
      const queued = this.#enqueue(record.partition, resource, async () => {
        if (!active()) return;
        if (command.environment) {
          try {
            if (!this.options.environments) throw new Error("Environment coordinator unavailable");
            await this.options.environments.ensure(
              command.scope,
              command.environment,
              active,
              controller.signal,
            );
          } catch {
            if (active())
              await this.#fail(command, {
                code: "cubesandbox_tool_unavailable",
                effect: "not_started",
                message:
                  "The execution environment could not be prepared. This Tool was not submitted.",
              });
            return;
          }
        }
        if (active()) await this.#deliver(record, active);
      });
      const result = queued.result.finally(() => {
        this.#preparing.delete(key);
      });
      this.#preparing.set(key, { bindingId, command, controller, result });
      void result.catch(() =>
        operationalLog({
          service: "pi-cloud-session-runtime",
          level: "error",
          event: "tool.prepared_dispatch_failed",
        }),
      );
      if (!command.environment && !queued.queued) await result;
      return;
    }
    if (record.fact.kind === "tool_cancel") {
      const cancel = record.fact as AcceptedToolCancellation;
      const pending = this.#preparing.get(cancel.request.operationId);
      pending?.controller.abort(new Error("Tool cancelled before handoff"));
      const route = await this.options.routes.get(
        cancel.request.originalWriterId
          ? { ...cancel.scope, writerId: cancel.request.originalWriterId }
          : cancel.scope,
        cancel.request.activationId,
      );
      if (!route) return; // Nothing was submitted, or immutable cleanup is in the close Outbox.
      const queued = this.#enqueue(
        record.partition,
        this.#resourceKey(record.partition, route.snapshot),
        async () => {
          if (current()) await this.#deliver(record, current);
        },
      );
      void queued.result.catch(() => {});
      if (!queued.queued) await queued.result;
      return;
    }
    if (record.fact.kind === "work_finished" || record.fact.kind === "execution_seal") {
      const writerId = record.fact.scope.writerId;
      this.options.environments?.retireWriter(writerId);
      for (const pending of this.#preparing.values())
        if (pending.command.scope.writerId === writerId)
          pending.controller.abort(new Error("Tool writer closed before handoff"));
    }
    return this.#deliver(record, current);
  }

  async #deliver(record: ToolLogRecord<ToolLogFact>, current?: () => boolean): Promise<void> {
    this.#consumed++;
    const fact = toolDeliveryFact(record.fact);
    this.options.metrics?.toolLogConsumed.inc({ kind: fact?.kind ?? "ignored" });
    if (!fact) return;
    const seal = fact.kind === "execution_seal";
    if (seal) {
      const terminal = (record.fact as { terminal?: { type: string } }).terminal;
      await this.options.routes.closeWriter(
        fact.scope,
        record.fact.kind === "execution_seal"
          ? !("recover" in record.fact && record.fact.recover === true)
          : terminal?.type !== "turn.completed",
      );
      return;
    }
    const invocation = fact as AcceptedToolCommand | AcceptedToolCancellation;
    const originalWriterId =
      fact.kind === "tool_cancel"
        ? (fact as AcceptedToolCancellation).request.originalWriterId
        : undefined;
    const route = await this.options.routes.get(
      originalWriterId ? { ...fact.scope, writerId: originalWriterId } : fact.scope,
      invocation.request.activationId,
    );
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
            writerId: originalWriterId ?? cancel.scope.writerId,
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
        await this.options.executor.submit(route, command, source);
      }
      this.#delivered++;
    } catch (error) {
      this.#abandoned++;
      const outcome = this.options.executor.handoffFailure(error);
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
    for (const pending of this.#preparing.values())
      if (pending.bindingId === change.entityId)
        pending.controller.abort(new Error("Tool binding closed"));
    if (!change.closed || !change.cancelTarget || !current()) return;
    const { writerId, ...target } = change.cancelTarget;
    const route = await this.options.routes.get(
      { tenantId: change.scope.tenantId, runId: change.runId, writerId },
      change.entityId,
    );
    const valid = this.#current(current);
    const queued = this.#enqueue(
      source.partition,
      route ? this.#resourceKey(source.partition, route.snapshot) : undefined,
      async () => {
        if (valid())
          await this.#cancel(
            target,
            { source, executionScopeId: change.entityId, writerId },
            valid,
          );
      },
    );
    void queued.result.catch(() => {});
    // ACK means routing is revoked, not that physical interruption completed.
    // A deleted binding's immutable target uses a conservative partition barrier.
    if (!queued.queued) await queued.result;
  }

  async #cancel(
    target: SandboxExecutionTarget,
    request: ToolExecutionCancellation,
    current?: () => boolean,
  ): Promise<void> {
    // Bound one partition's wait; the Worker independently bounds result
    // settlement. Retry only cancellation, never the original shell command.
    for (let attempt = 0; attempt < 2 && current?.() !== false; attempt++) {
      try {
        await this.options.executor.cancel(target, request);
        return;
      } catch (error) {
        if (this.options.executor.cancellationRefused(error)) break;
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
    this.reset();
    await Promise.allSettled([
      ...[...this.#preparing.values()].map((p) => p.result),
      ...[...this.#resourceTails.values()].map((p) => p.result),
      ...this.#partitionBarriers.values(),
    ]);
    await this.options.workflow.close?.();
  }
  reset(): void {
    this.#generation++;
    for (const pending of this.#preparing.values())
      pending.controller.abort(new Error("Tool dispatch owner changed"));
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
