import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { AcceptedFactTerminalOutboxRelay } from "./accepted-fact-terminal-outbox-relay.ts";
import { KafkaCanonicalProjector } from "./kafka-canonical-projector.ts";
import {
  KafkaAcceptedFactBus,
  ACCEPTED_FACT_TOPIC,
  type KafkaAcceptedFactConfiguration,
} from "./kafka-accepted-fact.ts";

/** Optional background role: no live-tail replica, browser gateway or model secrets. */
export class KafkaProjectionRuntime {
  readonly #bus: KafkaAcceptedFactBus;
  readonly #canonical: KafkaCanonicalProjector;
  readonly #terminal: AcceptedFactTerminalOutboxRelay;
  constructor(options: KafkaAcceptedFactConfiguration & { database: Kysely<Database> }) {
    this.#bus = new KafkaAcceptedFactBus(options);
    this.#canonical = new KafkaCanonicalProjector({
      retentionMs: options.retentionMs,
      database: options.database,
      brokers: options.brokers,
      topic: options.topic ?? ACCEPTED_FACT_TOPIC,
      clientId: options.clientId,
    });
    this.#terminal = new AcceptedFactTerminalOutboxRelay({
      database: options.database,
      bus: this.#bus,
    });
  }
  async start(): Promise<void> {
    await this.#bus.start();
    await this.#canonical.start();
    this.#terminal.start();
  }
  async checkHealth(): Promise<void> {
    await this.#bus.checkHealth();
    this.#canonical.checkHealth();
    this.#terminal.checkHealth();
  }
  async close(): Promise<void> {
    await this.#terminal.close();
    await this.#canonical.close();
    await this.#bus.close();
  }
}
