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
import { AcceptedFactCapacityError } from "./accepted-fact.ts";
import type { PiCloudMetrics } from "@pi-cloud/observability";

import { once } from "node:events";
import {
  ACCEPTED_FACT_TOPIC,
  DEFAULT_PRODUCER_CAPACITY,
  type ProducerCapacity,
} from "@pi-cloud/event-log";
export { ACCEPTED_FACT_TOPIC };
export { loadProducerCapacity, type ProducerCapacity } from "@pi-cloud/event-log";

export type KafkaAcceptedFactConfiguration = Readonly<{
  brokers: readonly string[];
  clientId: string;
  topic?: string;
  partitions: number;
  replicas: number;
  retentionMs: number;
  producerLanes?: number;
  capacity?: ProducerCapacity;
  closeTimeoutMs?: number;
  metrics?: PiCloudMetrics;
}>;

type PendingAcceptedFact = {
  bytes: number;
  promise: Promise<AcceptedFactReceipt>;
  resolve(receipt: AcceptedFactReceipt): void;
  reject(error: Error): void;
};

type KafkaProducerLane = {
  producer: Producer<string, string, string, string>;
  stream: ProducerStream<string, string, string, string>;
  pending: Array<{ factId: string; receipt: PendingAcceptedFact }>;
  writes: Promise<void>;
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
  if (parsed.kind === "agent_event") {
    return { ...parsed, event: parsePiCloudEvent(parsed.event) };
  }
  if (parsed.kind === "execution_seal" || parsed.kind === "tool_command") return parsed;
  if (parsed.kind === "execution_committed") {
    return { ...parsed, event: parsePiCloudEvent(parsed.event) as typeof parsed.event };
  }
  if (parsed.kind === "pi_session_append") {
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
  readonly #capacity: ProducerCapacity;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #closeTimeoutMs: number;
  readonly #failed = new AbortController();
  #pendingBytes = 0;
  #peakPendingBytes = 0;
  #drainWaits = 0;
  #capacityRejections = 0;
  #closing: Promise<void> | undefined;
  #started = false;
  #streamFailure: Error | undefined;
  readonly #pending = new Map<string, PendingAcceptedFact>();

  constructor(configuration: KafkaAcceptedFactConfiguration) {
    const bootstrapBrokers = brokers(configuration.brokers);
    this.#topic = configuration.topic ?? ACCEPTED_FACT_TOPIC;
    this.#partitions = positiveInteger(configuration.partitions, "Kafka partitions");
    this.#replicas = positiveInteger(configuration.replicas, "Kafka replicas");
    positiveInteger(configuration.retentionMs, "Kafka retentionMs");
    const capacity = configuration.capacity ?? DEFAULT_PRODUCER_CAPACITY;
    this.#capacity = {
      maximumPendingBytes: positiveInteger(capacity.maximumPendingBytes, "maximumPendingBytes"),
      maximumPendingFacts: positiveInteger(capacity.maximumPendingFacts, "maximumPendingFacts"),
    };
    this.#metrics = configuration.metrics;
    this.#observe();
    this.#closeTimeoutMs = positiveInteger(configuration.closeTimeoutMs ?? 10000, "closeTimeoutMs");
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
      const lane: KafkaProducerLane = { producer, stream, pending: [], writes: Promise.resolve() };
      stream.on(
        "delivery-report" as never,
        ((report: { count?: unknown }) => this.#resolveDeliveryBatch(lane, report)) as never,
      );
      stream.on("error", (error) => this.#fail(error));
      stream.on("close", () => {
        if (lane.pending.length)
          this.#fail(new Error("Kafka stream closed before delivery confirmation"));
      });
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
    if (this.#streamFailure) return;
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
      this.#pendingBytes -= delivered.receipt.bytes;
      delivered.receipt.resolve({ factId: delivered.factId, durable: true });
    }
    this.#observe();
  }

  #fail(error: Error): void {
    if (this.#streamFailure !== undefined) return;
    this.#streamFailure = error;
    this.#failed.abort(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.#observe();
    for (const lane of this.#lanes) {
      lane.pending.length = 0;
      lane.stream.destroy(error);
    }
  }

  async start(): Promise<void> {
    if (this.#started || this.#closing)
      throw new Error("Kafka AcceptedFactBus can only start once");
    const topics = await this.#admin.listTopics();
    if (!topics.includes(this.#topic)) {
      await this.#admin.createTopics({
        topics: [this.#topic],
        partitions: this.#partitions,
        replicas: this.#replicas,
        configs: [
          { name: "cleanup.policy", value: "delete" },
          { name: "retention.ms", value: "-1" },
          { name: "retention.bytes", value: "-1" },
          { name: "message.timestamp.type", value: "LogAppendTime" },
          { name: "min.insync.replicas", value: String(Math.max(1, this.#replicas - 1)) },
        ],
      });
    }
    const metadata = await this.#admin.metadata({ topics: [this.#topic], forceUpdate: true });
    if (metadata.topics.get(this.#topic)?.partitionsCount !== this.#partitions)
      throw new Error("AcceptedFact partition count cannot change within a topic generation");
    this.#started = true;
  }

  async append(fact: AcceptedFact): Promise<AcceptedFactReceipt> {
    if (!this.#started) throw new Error("Kafka AcceptedFactBus is not running");
    if (this.#streamFailure !== undefined) throw this.#streamFailure;
    const existing = this.#pending.get(fact.factId);
    if (existing !== undefined) return existing.promise;
    const value = JSON.stringify(fact);
    const bytes = Buffer.byteLength(value);
    if (
      this.#pending.size >= this.#capacity.maximumPendingFacts ||
      this.#pendingBytes + bytes > this.#capacity.maximumPendingBytes
    ) {
      this.#capacityRejections++;
      this.#metrics?.kafkaProducerRejected.inc();
      throw new AcceptedFactCapacityError();
    }
    let resolveReceipt!: (receipt: AcceptedFactReceipt) => void;
    let rejectReceipt!: (error: Error) => void;
    const promise = new Promise<AcceptedFactReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const receipt: PendingAcceptedFact = {
      bytes,
      promise,
      resolve: resolveReceipt,
      reject: rejectReceipt,
    };
    this.#pending.set(fact.factId, receipt);
    this.#pendingBytes += bytes;
    this.#peakPendingBytes = Math.max(this.#peakPendingBytes, this.#pendingBytes);
    this.#observe();
    const lane = this.#lanes[kafkaProducerLane(fact.scope.piSessionId, this.#lanes.length)]!;
    lane.writes = lane.writes
      .then(async () => {
        if (this.#streamFailure) throw this.#streamFailure;
        lane.pending.push({ factId: fact.factId, receipt });
        const writable = lane.stream.write({
          topic: this.#topic,
          partition: kafkaProducerLane(fact.scope.piSessionId, this.#partitions),
          key: fact.scope.piSessionId,
          value,
          headers: { "pi-cloud-fact-id": fact.factId },
        });
        if (!writable) {
          this.#drainWaits++;
          await once(lane.stream, "drain", { signal: this.#failed.signal });
        }
      })
      .catch((error: Error) => this.#fail(error));
    return promise;
  }

  statistics() {
    return {
      pendingFacts: this.#pending.size,
      pendingBytes: this.#pendingBytes,
      peakPendingBytes: this.#peakPendingBytes,
      drainWaits: this.#drainWaits,
      capacityRejections: this.#capacityRejections,
      ...this.#capacity,
    };
  }

  #observe() {
    this.#metrics?.kafkaProducerPendingBytes.set(this.#pendingBytes);
    this.#metrics?.kafkaProducerPendingFacts.set(this.#pending.size);
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

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#started = false;
    this.#closing = (async () => {
      const timer = setTimeout(
        () => this.#fail(new Error("Kafka producer close timed out")),
        this.#closeTimeoutMs,
      );
      try {
        await Promise.all(this.#lanes.map((lane) => lane.writes));
        await Promise.allSettled(this.#lanes.map((lane) => lane.stream.close()));
      } finally {
        clearTimeout(timer);
        await Promise.allSettled([
          ...this.#lanes.map((lane) => lane.producer.close()),
          this.#admin.close(),
        ]);
      }
      if (this.#streamFailure) throw this.#streamFailure;
    })();
    return this.#closing;
  }
}
