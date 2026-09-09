import type { PiSessionAppendPublisher } from "@pi-cloud/pi-session-postgres";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import type { ActiveExecutionLogResolver, CandidatePiSessionAppendFact } from "./accepted-fact.ts";

export type PiSessionAppendScope = CandidatePiSessionAppendFact["scope"];

/** The Harness append boundary ends at Kafka replication ACK. There is no
 * PG receipt map, polling loop, second payload copy or per-Step read barrier. */
export class NativeSessionLogPublisher {
  readonly #channels: ActiveExecutionLogResolver;
  readonly #metrics: PiCloudMetrics | undefined;
  #closed = false;
  constructor(options: { channels: ActiveExecutionLogResolver; metrics?: PiCloudMetrics }) {
    this.#channels = options.channels;
    this.#metrics = options.metrics;
  }
  scoped(scope: PiSessionAppendScope): PiSessionAppendPublisher {
    return {
      publish: async (items, events = []) => {
        if (this.#closed) throw new Error("Pi Session append publisher is closed");
        const channel = this.#channels.resolve(scope.executionLease);
        if (!channel) throw new Error("Pi Session Fact Stream is unavailable");
        const mutationId = crypto.randomUUID(),
          started = performance.now();
        const ack = await channel.mutate({
          schemaVersion: 1,
          mutationId,
          scope,
          items,
          events,
          occurredAt: new Date().toISOString(),
        });
        if (ack.mutationId !== mutationId || !ack.accepted)
          throw new Error("Pi Session append identity changed");
        this.#metrics?.sessionMutationWait.observe(
          { stage: "kafka_publish" },
          (performance.now() - started) / 1000,
        );
      },
    };
  }
  async checkHealth() {
    if (this.#closed) throw new Error("Pi Session append publisher is closed");
    await this.#channels.checkHealth();
  }
  async close() {
    this.#closed = true;
  }
}
