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
  constructor(
    readonly options: KafkaAcceptedFactConfiguration & {
      database: Kysely<Database>;
      advertisedBaseUrl: string;
      toolCommands: {
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
      return () => {};
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
      decode: (value) => JSON.parse(value.toString()) as AcceptedFact,
      replayOffsets: (bounds) => loadFactReplayOffsets(options.database, topic, bounds),
      onReset: () => {
        this.#projection.reset();
        this.#publication.reset();
        this.eventStore.reset();
      },
      handler: async (record, current) => {
        if (!(await this.#publication.accept(record)) || current?.() === false) return;
        const fact = parseKafkaAcceptedFact(JSON.stringify(record.fact));
        const accepted = { ...record, fact };
        const terminal = await this.#projection.project(accepted);
        if (current?.() === false) return;
        const applicable =
          fact.kind === "execution_seal" || (await this.#projection.accepts(accepted));
        if (current?.() === false) return;
        if (terminal) this.eventStore.accept(fact.scope.tenantId, terminal);
        if (applicable) {
          for (const event of factEvents(fact)) this.eventStore.accept(fact.scope.tenantId, event);
          await options.toolCommands.consume(accepted, current);
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
  async close(): Promise<void> {
    this.#ready = false;
    await this.#relay.close();
    await this.#consumer.close();
    await this.options.toolCommands.close?.();
    await this.#retention.close();
    this.eventStore.close();
    await this.#bus.close();
  }
}
