import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { AcceptedFactTerminalOutboxRelay } from "./accepted-fact-terminal-outbox-relay.ts";
import { PostgresExecutionLeaseAuthorityGate } from "./session-lease-authority-gate.ts";
import { FactChannelService } from "./accepted-fact-channel.ts";
import {
  ACCEPTED_FACT_TOPIC,
  KafkaAcceptedFactBus,
  type KafkaAcceptedFactConfiguration,
} from "./kafka-accepted-fact.ts";
import { KafkaCanonicalProjector } from "./kafka-canonical-projector.ts";
import { KafkaLiveSessionTail } from "./kafka-live-session-tail.ts";
import { LiveTailTerminalTurnProjectionSource } from "./live-tail-terminal-projection.ts";
import { PostgresAcceptedFactProgressStore } from "./postgres-accepted-fact-progress.ts";

export type KafkaEventRuntimeOptions = Readonly<{
  database: Kysely<Database>;
  brokers: readonly string[];
  instanceId: string;
  topic?: string;
  partitions: number;
  replicas: number;
  retentionMs: number;
  factChannelLeaseMs?: number;
  factChannelMaximumActive?: number;
}>;

export class KafkaEventRuntime {
  readonly factChannels: FactChannelService;
  readonly eventStore: KafkaLiveSessionTail;
  readonly eventHub;
  readonly terminalTurnProjectionSource: LiveTailTerminalTurnProjectionSource;
  readonly #bus: KafkaAcceptedFactBus;
  readonly #canonical: KafkaCanonicalProjector;
  readonly #terminalRelay: AcceptedFactTerminalOutboxRelay;
  #started = false;

  constructor(options: KafkaEventRuntimeOptions) {
    const topic = options.topic ?? ACCEPTED_FACT_TOPIC;
    const configuration: KafkaAcceptedFactConfiguration = {
      brokers: options.brokers,
      clientId: options.instanceId,
      topic,
      partitions: options.partitions,
      replicas: options.replicas,
      retentionMs: options.retentionMs,
    };
    this.#bus = new KafkaAcceptedFactBus(configuration);
    this.eventStore = new KafkaLiveSessionTail({
      brokers: options.brokers,
      topic,
      clientId: options.instanceId,
      instanceId: options.instanceId,
    });
    this.eventHub = this.eventStore.eventHub;
    this.#canonical = new KafkaCanonicalProjector({
      database: options.database,
      brokers: options.brokers,
      topic,
      clientId: options.instanceId,
    });
    this.factChannels = new FactChannelService({
      authority: new PostgresExecutionLeaseAuthorityGate({
        database: options.database,
        ...(options.factChannelLeaseMs === undefined
          ? {}
          : { leaseDurationMs: options.factChannelLeaseMs }),
      }),
      bus: this.#bus,
      progress: new PostgresAcceptedFactProgressStore(options.database),
      instanceId: options.instanceId,
      ...(options.factChannelLeaseMs === undefined
        ? {}
        : { leaseDurationMs: options.factChannelLeaseMs }),
      ...(options.factChannelMaximumActive === undefined
        ? {}
        : { maximumActiveChannels: options.factChannelMaximumActive }),
    });
    this.terminalTurnProjectionSource = new LiveTailTerminalTurnProjectionSource({
      database: options.database,
      events: this.eventStore,
    });
    this.#terminalRelay = new AcceptedFactTerminalOutboxRelay({
      database: options.database,
      bus: this.#bus,
    });
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Kafka event runtime can only start once");
    this.#started = true;
    try {
      await this.#bus.start();
      await this.eventStore.start();
      await this.#canonical.start();
      this.#terminalRelay.start();
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  async checkHealth(): Promise<void> {
    if (!this.#started) throw new Error("Kafka event runtime is not running");
    await this.#bus.checkHealth();
    this.eventStore.checkHealth();
    this.#canonical.checkHealth();
    this.#terminalRelay.checkHealth();
    await this.factChannels.checkHealth();
  }

  statistics() {
    return {
      factChannels: this.factChannels.statistics(),
      liveTail: this.eventStore.statistics(),
    } as const;
  }

  async close(): Promise<void> {
    this.#started = false;
    await this.#terminalRelay.close().catch(() => undefined);
    await this.#canonical.close().catch(() => undefined);
    await this.eventStore.close().catch(() => undefined);
    await this.factChannels.close().catch(() => undefined);
    await this.#bus.close().catch(() => undefined);
  }
}
