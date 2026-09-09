import { randomUUID } from "node:crypto";
import { KafkaLogConsumer, type KafkaLogRecord } from "@pi-cloud/event-log";
import type { AcceptedToolCommand } from "@pi-cloud/protocol";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import type { ToolLogFact } from "./tool-command-executor.ts";
import type { ToolCommandRoute, ToolCommandRoutes } from "./tool-command-routes.ts";

export const TOOL_BROKER_LOG_DELIVERY_PATH = "/internal/v1/tool-log-delivery";
export type ToolLogDelivery = Readonly<{
  instanceId: string;
  topic: string;
  partition: number;
  offset: string;
  fact: ToolLogFact;
}>;

export function toolDeliveryFact(fact: ToolLogFact): ToolLogFact | undefined {
  if (fact.kind === "tool_command") return fact;
  if (fact.kind === "execution_seal" || fact.kind === "execution_committed")
    return { kind: fact.kind, scope: fact.scope, closesWriter: fact.closesWriter === true };
  if (fact.kind !== "pi_session_append") return undefined;
  const events = (fact.events ?? [])
    .filter((e) => e.type === "tool.completed" && e.payload.toolCallId)
    .map((e) => ({ type: e.type, payload: { toolCallId: e.payload.toolCallId! } }));
  return events.length ? { kind: fact.kind, scope: fact.scope, events } : undefined;
}

/** Partition ownership is independent from boot-local Cube ownership. */
export class KafkaToolCommandConsumer {
  readonly #consumer: KafkaLogConsumer<ToolLogFact>;
  readonly #routes: ToolCommandRoutes;
  readonly #deliver: (route: ToolCommandRoute, delivery: ToolLogDelivery) => Promise<void>;
  readonly #cache = new Map<string, readonly ToolCommandRoute[]>();
  #consumed = 0;
  #delivered = 0;
  #abandoned = 0;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #instanceId: string | undefined;

  constructor(options: {
    brokers: readonly string[];
    topic: string;
    groupId: string;
    instanceId?: string;
    metrics?: PiCloudMetrics;
    routes: ToolCommandRoutes;
    deliver: (route: ToolCommandRoute, delivery: ToolLogDelivery) => Promise<void>;
  }) {
    this.#routes = options.routes;
    this.#metrics = options.metrics;
    this.#instanceId = options.instanceId;
    this.#deliver = options.deliver;
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      topic: options.topic,
      groupId: options.groupId,
      clientId: `tool-router-${options.instanceId ?? randomUUID()}`,
      groupRecovery: true,
      decode: (value) => JSON.parse(value.toString()) as ToolLogFact,
      handler: (record) => this.consume(record),
    });
  }
  async start(): Promise<void> {
    await this.#consumer.start();
    await this.#consumer.waitUntilAssigned();
  }
  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  async consume(record: KafkaLogRecord<ToolLogFact>): Promise<void> {
    this.#consumed++;
    const fact = toolDeliveryFact(record.fact);
    this.#metrics?.toolLogConsumed.inc({ kind: fact?.kind ?? "ignored" });
    if (!fact) return;
    const seal = fact.kind === "execution_seal" || fact.kind === "execution_committed";
    const key = `${fact.scope.tenantId}:${fact.scope.attemptId}`;
    let routes = seal ? undefined : this.#cache.get(key);
    // A second binding may have been created since a prior result. Never cache
    // absence, and refresh when the command names a previously unseen binding.
    if (
      fact.kind === "tool_command" &&
      !routes?.some((r) => r.bindingId === (fact as AcceptedToolCommand).request.activationId)
    )
      routes = undefined;
    if (!routes) {
      routes = await this.#routes.find(fact.scope, seal && fact.closesWriter === true);
      if (!seal && routes.length) {
        this.#cache.set(key, routes);
        if (this.#cache.size > 4096) this.#cache.delete(this.#cache.keys().next().value!);
      }
    }
    if (fact.kind === "tool_command")
      routes = routes.filter(
        (r) => r.bindingId === (fact as AcceptedToolCommand).request.activationId,
      );
    const owners = new Map(routes.map((r) => [r.instanceId, r]));
    await Promise.all(
      [...owners.values()].map(async (route) => {
        const started = performance.now();
        let outcome = "delivered";
        try {
          await this.#deliver(route, {
            instanceId: route.instanceId,
            topic: record.topic,
            partition: record.partition,
            offset: record.offset.toString(),
            fact,
          });
          this.#delivered++;
        } catch (error) {
          // An uncertain live-owner delivery is replayed at the same Kafka offset.
          // A vanished boot's bindings cannot be adopted or executed elsewhere.
          outcome = "retry";
          if (await this.#routes.isAlive(route.instanceId)) throw error;
          this.#abandoned++;
          outcome = "abandoned";
        } finally {
          this.#metrics?.toolLogDelivery.observe(
            { route: route.instanceId === this.#instanceId ? "local" : "remote", outcome },
            (performance.now() - started) / 1000,
          );
        }
      }),
    );
    if (seal) this.#cache.delete(key);
  }

  statistics() {
    return {
      consumedFacts: this.#consumed,
      deliveredRecords: this.#delivered,
      abandonedDeliveries: this.#abandoned,
    };
  }
  async close(): Promise<void> {
    await this.#consumer.close();
    this.#cache.clear();
  }
}

export function httpToolLogDelivery(token: string) {
  return async (route: ToolCommandRoute, delivery: ToolLogDelivery): Promise<void> => {
    const response = await fetch(new URL(TOOL_BROKER_LOG_DELIVERY_PATH, route.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(delivery),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Tool log delivery failed: HTTP ${response.status}`);
  };
}
