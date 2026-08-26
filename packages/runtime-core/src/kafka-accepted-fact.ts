import {
  Admin,
  ProduceAcks,
  Producer,
  ProducerStreamReportModes,
  stringSerializers,
  type ProducerStream,
} from "@platformatic/kafka";
import { parsePiCloudEvent } from "@pi-cloud/protocol";
import type { AcceptedFact, AcceptedFactBus, AcceptedFactReceipt } from "./accepted-fact.ts";

export const ACCEPTED_FACT_TOPIC = "pi-cloud.accepted-facts.v1";

export type KafkaAcceptedFactConfiguration = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic?: string;
  partitions: number;
  replicas: number;
  retentionMs: number;
}>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function brokers(values: readonly string[]): string[] {
  if (values.length < 1 || values.some((value) => value.trim().length === 0)) {
    throw new TypeError("Kafka brokers are invalid");
  }
  return [...values];
}

export function parseKafkaAcceptedFact(value: string | Buffer): AcceptedFact {
  const parsed = JSON.parse(
    Buffer.isBuffer(value) ? value.toString("utf8") : value,
  ) as AcceptedFact;
  if (parsed.kind === "agent_event" || parsed.kind === "terminal_event") {
    return { ...parsed, event: parsePiCloudEvent(parsed.event) };
  }
  if (parsed.kind === "pi_session_mutation") return parsed;
  throw new TypeError("Kafka AcceptedFact kind is invalid");
}

export class KafkaAcceptedFactBus implements AcceptedFactBus {
  readonly #topic: string;
  readonly #producer: Producer<string, string, string, string>;
  readonly #stream: ProducerStream<string, string, string, string>;
  readonly #admin: Admin;
  readonly #partitions: number;
  readonly #replicas: number;
  readonly #retentionMs: number;
  #started = false;
  #streamFailure: Error | undefined;
  readonly #pending = new Map<
    string,
    {
      promise: Promise<AcceptedFactReceipt>;
      resolve(receipt: AcceptedFactReceipt): void;
      reject(error: Error): void;
    }
  >();

  constructor(configuration: KafkaAcceptedFactConfiguration) {
    const bootstrapBrokers = brokers(configuration.brokers);
    this.#topic = configuration.topic ?? ACCEPTED_FACT_TOPIC;
    this.#partitions = positiveInteger(configuration.partitions, "Kafka partitions");
    this.#replicas = positiveInteger(configuration.replicas, "Kafka replicas");
    this.#retentionMs = positiveInteger(configuration.retentionMs, "Kafka retentionMs");
    this.#producer = new Producer({
      clientId: `${configuration.clientId}-accepted-fact-producer`,
      bootstrapBrokers,
      serializers: stringSerializers,
      idempotent: true,
      acks: ProduceAcks.ALL,
      autocreateTopics: false,
    });
    this.#stream = this.#producer.asStream({
      acks: ProduceAcks.ALL,
      idempotent: true,
      autocreateTopics: false,
      batchSize: 128,
      batchTime: 2,
      highWaterMark: 1_024,
      reportMode: ProducerStreamReportModes.MESSAGE,
    });
    this.#stream.on(
      "delivery-report" as never,
      ((report: { message: { metadata?: unknown } }) => {
        const factId = (report.message.metadata as { factId?: unknown } | undefined)?.factId;
        if (typeof factId !== "string") return;
        const pending = this.#pending.get(factId);
        if (pending === undefined) return;
        this.#pending.delete(factId);
        pending.resolve({ factId, durable: true });
      }) as never,
    );
    this.#stream.on("error", (error) => {
      this.#streamFailure = error;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
    this.#admin = new Admin({
      clientId: `${configuration.clientId}-accepted-fact-admin`,
      bootstrapBrokers,
      autocreateTopics: false,
    });
  }

  get topic(): string {
    return this.#topic;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Kafka AcceptedFactBus can only start once");
    const topics = await this.#admin.listTopics();
    if (!topics.includes(this.#topic)) {
      await this.#admin.createTopics({
        topics: [this.#topic],
        partitions: this.#partitions,
        replicas: this.#replicas,
        configs: [
          { name: "cleanup.policy", value: "delete" },
          { name: "retention.ms", value: String(this.#retentionMs) },
          { name: "min.insync.replicas", value: String(Math.max(1, this.#replicas - 1)) },
        ],
      });
    }
    this.#started = true;
  }

  async append(fact: AcceptedFact): Promise<AcceptedFactReceipt> {
    if (!this.#started) throw new Error("Kafka AcceptedFactBus is not running");
    if (this.#streamFailure !== undefined) throw this.#streamFailure;
    const existing = this.#pending.get(fact.factId);
    if (existing !== undefined) return existing.promise;
    let resolveReceipt!: (receipt: AcceptedFactReceipt) => void;
    let rejectReceipt!: (error: Error) => void;
    const promise = new Promise<AcceptedFactReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    this.#pending.set(fact.factId, {
      promise,
      resolve: resolveReceipt,
      reject: rejectReceipt,
    });
    this.#stream.write({
      topic: this.#topic,
      key: fact.scope.sessionId,
      value: JSON.stringify(fact),
      headers: { "pi-cloud-fact-id": fact.factId },
      metadata: { factId: fact.factId },
    });
    return promise;
  }

  async checkHealth(): Promise<void> {
    if (
      !this.#started ||
      this.#streamFailure !== undefined ||
      !(await this.#admin.listTopics()).includes(this.#topic)
    ) {
      throw new Error("Kafka AcceptedFactBus is unhealthy");
    }
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    await this.#stream.close().catch(() => undefined);
    await Promise.allSettled([this.#producer.close(), this.#admin.close()]);
  }
}
