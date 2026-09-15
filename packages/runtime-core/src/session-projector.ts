import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaLogConsumer } from "@pi-cloud/event-log";
import {
  KafkaAcceptedFactBus,
  ACCEPTED_FACT_TOPIC,
  kafkaProducerLane,
  parseKafkaAcceptedFact,
  type KafkaAcceptedFactConfiguration,
} from "./kafka-accepted-fact.ts";
import { ExecutionStreamProjector, factEvents } from "./execution-stream-projection.ts";
import { ExecutionPublicationBoundary } from "./execution-publication.ts";
import { SessionLiveView } from "./session-live-view.ts";
import { AcceptedFactTerminalOutboxRelay } from "./accepted-fact-terminal-outbox-relay.ts";
import { KafkaSafeRetention } from "./kafka-safe-retention.ts";
import { loadFactReplayOffsets } from "./accepted-fact-recovery.ts";
import type { AcceptedFact } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";

const PREFIX = "pi-cloud-projector@";
export class SessionProjector {
  readonly eventStore: SessionLiveView;
  readonly eventHub;
  readonly #consumer: KafkaLogConsumer<AcceptedFact>;
  readonly #bus: KafkaAcceptedFactBus;
  readonly #relay: AcceptedFactTerminalOutboxRelay;
  readonly #retention: KafkaSafeRetention;
  readonly #projection: ExecutionStreamProjector;
  readonly #publication: ExecutionPublicationBoundary;
  #partitions = 0;
  #ready = false;
  #closing: Promise<void> | undefined;
  constructor(
    readonly options: KafkaAcceptedFactConfiguration & {
      database: Kysely<Database>;
      advertisedBaseUrl: string;
      toolCommands: {
        consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void>;
        close?(): Promise<void>;
      };
      subagentCommands?: {
        consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void>;
        close?(): Promise<void>;
      };
    },
  ) {
    const topic = options.topic ?? ACCEPTED_FACT_TOPIC;
    this.#bus = new KafkaAcceptedFactBus(options);
    this.eventStore = new SessionLiveView(async (tenant, session) => {
      const p = await this.#partition(tenant, session);
      if (!this.#consumer.ownsPartition(p))
        throw new Error("Session Projector assignment changed; reconnect");
      await this.#consumer.waitForPartition(p);
    });
    this.eventHub = this.eventStore.eventHub;
    this.#publication = new ExecutionPublicationBoundary(options.database);
    this.#projection = new ExecutionStreamProjector(options.database);
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      topic,
      groupId: "pi-cloud-session-projector-v1",
      clientId:
        PREFIX + Buffer.from(new URL(options.advertisedBaseUrl).toString()).toString("base64url"),
      groupRecovery: true,
      decode: parseKafkaAcceptedFact,
      replayOffsets: (bounds) => loadFactReplayOffsets(options.database, topic, bounds),
      onReset: () => {
        this.#projection.reset();
        this.#publication.reset();
        this.eventStore.reset();
      },
      handler: async (record, current) => {
        if (!(await this.#publication.accept(record)) || current?.() === false) return;
        const { fact } = record;
        const projected = await this.#projection.project(record);
        if (current?.() === false) return;
        const applicable =
          fact.kind === "execution_seal" || (await this.#projection.accepts(record));
        if (current?.() === false) return;
        if (projected?.terminal) this.eventStore.accept(fact.scope.tenantId, projected.terminal);
        if (applicable) {
          for (const event of factEvents(fact)) this.eventStore.accept(fact.scope.tenantId, event);
          if (projected?.canonicalThroughSequence !== undefined)
            this.eventStore.cover(
              fact.scope.tenantId,
              fact.scope.sessionId,
              projected.canonicalThroughSequence,
            );
          await options.toolCommands.consume(record, current);
          await options.subagentCommands?.consume(record, current);
        }
      },
    });
    this.#relay = new AcceptedFactTerminalOutboxRelay({
      database: options.database,
      bus: this.#bus,
    });
    this.#retention = new KafkaSafeRetention({ ...options, topic, graceMs: options.retentionMs });
    this.eventStore.owner = (tenant, session) => this.owner(tenant, session);
  }
  async #partition(tenant: string, sessionId: string): Promise<number> {
    const session = await this.options.database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("tenant_id", "=", tenant)
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return kafkaProducerLane(session.pi_session_id, this.#partitions);
  }
  async owner(tenant: string, session: string): Promise<string | undefined> {
    const p = await this.#partition(tenant, session);
    if (this.#consumer.ownsPartition(p)) return undefined;
    const client = await this.#consumer.ownerClientId(p);
    if (!client?.startsWith(PREFIX)) throw new Error("Session Projector owner unavailable");
    const owner = new URL(
      Buffer.from(client.slice(PREFIX.length), "base64url").toString(),
    ).toString();
    if (owner === new URL(this.options.advertisedBaseUrl).toString())
      throw new Error("Session Projector assignment is settling");
    return owner;
  }
  ownsPartition(partition: number): boolean {
    return this.#consumer.ownsPartition(partition);
  }
  async start(): Promise<void> {
    await this.#bus.start();
    this.#partitions = await this.#consumer.partitionCount();
    await this.#consumer.start();
    this.#relay.start();
    this.#retention.start(this.#partitions);
    this.#ready = true;
  }
  async checkHealth(): Promise<void> {
    await this.checkIngestHealth();
    this.#consumer.checkHealth();
    this.#relay.checkHealth();
    this.#retention.checkHealth();
  }
  async checkIngestHealth(): Promise<void> {
    if (!this.#ready) throw new Error("Projector not started");
    await this.#bus.checkHealth();
  }
  statistics() {
    return { liveTail: this.eventStore.statistics() };
  }
  close(): Promise<void> {
    this.#ready = false;
    return (this.#closing ??= this.#close());
  }
  async #close(): Promise<void> {
    const errors: unknown[] = [];
    for (const close of [
      () => this.#relay.close(),
      () => this.#consumer.close(),
      () => this.options.toolCommands.close?.(),
      () => this.options.subagentCommands?.close?.(),
      () => this.#retention.close(),
      () => this.eventStore.close(),
      () => this.#bus.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Session Projector cleanup failed");
  }
}
