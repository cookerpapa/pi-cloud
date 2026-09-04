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
  producerLanes?: number;
}>;

type PendingAcceptedFact = {
  promise: Promise<AcceptedFactReceipt>;
  resolve(receipt: AcceptedFactReceipt): void;
  reject(error: Error): void;
};

type KafkaProducerLane = {
  producer: Producer<string, string, string, string>;
  stream: ProducerStream<string, string, string, string>;
  pending: Array<{ factId: string; receipt: PendingAcceptedFact }>;
};

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

export function kafkaProducerLane(sessionId: string, lanes: number): number {
  const laneCount = positiveInteger(lanes, "Kafka producer lanes");
  let hash = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % laneCount;
}

export function parseKafkaAcceptedFact(value: string | Buffer): AcceptedFact {
  const parsed = JSON.parse(
    Buffer.isBuffer(value) ? value.toString("utf8") : value,
  ) as AcceptedFact;
  if (parsed.kind === "agent_event" || parsed.kind === "terminal_event") {
    return { ...parsed, event: parsePiCloudEvent(parsed.event) };
  }
  if (parsed.kind === "pi_session_mutation") {
    return {
      ...parsed,
      events: (parsed.events ?? []).map((event) => parsePiCloudEvent(event)),
    };
  }
  throw new TypeError("Kafka AcceptedFact kind is invalid");
}

export class KafkaAcceptedFactBus implements AcceptedFactBus {
  readonly #topic: string;
  readonly #lanes: readonly KafkaProducerLane[];
  readonly #admin: Admin;
  readonly #partitions: number;
  readonly #replicas: number;
  readonly #retentionMs: number;
  #started = false;
  #streamFailure: Error | undefined;
  readonly #pending = new Map<string, PendingAcceptedFact>();

  constructor(configuration: KafkaAcceptedFactConfiguration) {
    const bootstrapBrokers = brokers(configuration.brokers);
    this.#topic = configuration.topic ?? ACCEPTED_FACT_TOPIC;
    this.#partitions = positiveInteger(configuration.partitions, "Kafka partitions");
    this.#replicas = positiveInteger(configuration.replicas, "Kafka replicas");
    this.#retentionMs = positiveInteger(configuration.retentionMs, "Kafka retentionMs");
    const producerLanes = positiveInteger(configuration.producerLanes ?? 4, "producerLanes");
    this.#lanes = Array.from({ length: producerLanes }, (_, index) => {
      const producer = new Producer({
        clientId: `${configuration.clientId}-accepted-fact-producer-${String(index + 1)}`,
        bootstrapBrokers,
        serializers: stringSerializers,
        idempotent: true,
        acks: ProduceAcks.ALL,
        autocreateTopics: false,
      });
      const stream = producer.asStream({
        acks: ProduceAcks.ALL,
        idempotent: true,
        autocreateTopics: false,
        batchSize: 128,
        batchTime: 2,
        highWaterMark: 1_024,
        reportMode: ProducerStreamReportModes.BATCH,
      });
      const lane: KafkaProducerLane = { producer, stream, pending: [] };
      stream.on(
        "delivery-report" as never,
        ((report: { count?: unknown }) => this.#resolveDeliveryBatch(lane, report)) as never,
      );
      stream.on("error", (error) => this.#fail(error));
      return lane;
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

  #resolveDeliveryBatch(lane: KafkaProducerLane, report: { count?: unknown }): void {
    if (
      !Number.isSafeInteger(report.count) ||
      (report.count as number) < 1 ||
      (report.count as number) > lane.pending.length
    ) {
      const error = new Error("Kafka delivery batch did not match pending AcceptedFacts");
      this.#fail(error);
      lane.stream.destroy(error);
      return;
    }
    for (const delivered of lane.pending.splice(0, report.count as number)) {
      this.#pending.delete(delivered.factId);
      delivered.receipt.resolve({ factId: delivered.factId, durable: true });
    }
  }

  #fail(error: Error): void {
    if (this.#streamFailure !== undefined) return;
    this.#streamFailure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const lane of this.#lanes) lane.pending.length = 0;
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
    const receipt: PendingAcceptedFact = {
      promise,
      resolve: resolveReceipt,
      reject: rejectReceipt,
    };
    this.#pending.set(fact.factId, receipt);
    const lane = this.#lanes[kafkaProducerLane(fact.scope.sessionId, this.#lanes.length)]!;
    lane.pending.push({ factId: fact.factId, receipt });
    lane.stream.write({
      topic: this.#topic,
      key: fact.scope.sessionId,
      value: JSON.stringify(fact),
      headers: { "pi-cloud-fact-id": fact.factId },
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
    await Promise.all(this.#lanes.map((lane) => lane.stream.close().catch(() => undefined)));
    await Promise.allSettled([
      ...this.#lanes.map((lane) => lane.producer.close()),
      this.#admin.close(),
    ]);
  }
}
