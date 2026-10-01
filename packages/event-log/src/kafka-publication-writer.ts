import kafkaNative from "@confluentinc/kafka-javascript";
import type { Producer, LibrdKafkaError } from "@confluentinc/kafka-javascript";
import { PublicationNotSentError } from "@pi-cloud/protocol/native-session";
import type { KafkaPartitionReader } from "./kafka-partition-reader.ts";

export type KafkaPublicationRecord = Readonly<{ factId: string; sessionId: string; value: string }>;
type Pending = {
  record: KafkaPublicationRecord;
  resolve(value: { factId: string; durable: true }): void;
  reject(error: unknown): void;
};
export type KafkaPublicationWriterOptions = {
  brokers: readonly string[];
  clientId: string;
  topic: string;
  partition: number;
  reader: KafkaPartitionReader;
  current(): boolean;
};

/** One transactional transport owner per log partition, not per cold Session. */
export class KafkaPublicationWriter {
  readonly #options: KafkaPublicationWriterOptions;
  #producer: Producer | undefined;
  #opening: Promise<void> | undefined;
  #closed = false;
  #pending: Pending[] = [];
  #flushing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #failure: unknown;
  #retryAfter = 0;
  #closing: Promise<void> | undefined;

  constructor(options: KafkaPublicationWriterOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#closed || !this.#options.current())
      throw new PublicationNotSentError("Publication ownership ended");
    if (this.#producer && !this.#failure) return;
    this.#opening ??= this.#connect().finally(() => {
      this.#opening = undefined;
    });
    await this.#opening;
  }

  async #connect(): Promise<void> {
    const { brokers, clientId, topic, partition } = this.#options;
    const producer = new kafkaNative.Producer({
      "metadata.broker.list": brokers.join(","),
      "client.id": `${clientId}-publication-${partition}`,
      "transactional.id": `${topic}-publication-${partition}`,
      "enable.idempotence": true,
      acks: -1,
      "transaction.timeout.ms": 15_000,
      "queue.buffering.max.messages": 4096,
      "queue.buffering.max.kbytes": 65536,
      "linger.ms": 1,
      // Adjacent transactions can briefly retry coordinator requests. The
      // default 100ms backoff dominated measured small-record commit latency;
      // retain bounded exponential backoff while shortening its first wait.
      "retry.backoff.ms": 5,
      "retry.backoff.max.ms": 1000,
      "allow.auto.create.topics": false,
    });
    producer.on("event.error", () => {
      /* send/commit reports authoritative failure. */
    });
    try {
      await new Promise<void>((resolve, reject) =>
        producer.connect({ topic, timeout: 5000 }, (error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        producer.initTransactions(10_000, (error) => (error ? reject(error) : resolve())),
      );
      if (this.#closed || !this.#options.current())
        throw new Error("Publication owner changed during initialization");
      producer.setPollInterval(10);
      this.#producer = producer;
      this.#failure = undefined;
    } catch (error) {
      await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
      throw error;
    }
  }

  async append(record: KafkaPublicationRecord): Promise<{ factId: string; durable: true }> {
    if (this.#closed || !this.#options.current())
      return Promise.reject(new PublicationNotSentError("Publication owner is unavailable"));
    if (!this.#producer || this.#failure) {
      // Recovery never resubmits an uncertain application record. A later seal
      // or another Session can trigger a bounded new connection attempt.
      if (this.#flushing || Date.now() < this.#retryAfter)
        throw new PublicationNotSentError("Publication producer is recovering");
      try {
        await this.start();
      } catch (cause) {
        this.#retryAfter = Date.now() + 1000;
        throw new PublicationNotSentError("Publication producer could not recover", { cause });
      }
    }
    if (this.#closed || !this.#options.current())
      throw new PublicationNotSentError("Publication owner retired during recovery");
    const promise = new Promise<{ factId: string; durable: true }>((resolve, reject) =>
      this.#pending.push({ record, resolve, reject }),
    );
    this.#schedule();
    return promise;
  }

  #schedule(): void {
    if (this.#timer || this.#flushing || this.#closed || !this.#pending.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flush().finally(() => {
        this.#flushing = undefined;
        this.#schedule();
      });
      void this.#flushing.catch(() => {});
    }, 1);
  }

  async #flush(): Promise<void> {
    let count = 0,
      bytes = 0;
    for (const pending of this.#pending) {
      const size = Buffer.byteLength(pending.record.value);
      if (count && (count >= 128 || bytes + size > 4 * 1024 * 1024)) break;
      count++;
      bytes += size;
    }
    const batch = this.#pending.splice(0, count),
      producer = this.#producer;
    if (!producer || this.#closed || !this.#options.current()) {
      for (const pending of batch)
        pending.reject(new PublicationNotSentError("Publication owner retired before send"));
      return;
    }
    try {
      await this.#options.reader.commitPublication(this.#options.partition, producer, async () => {
        await new Promise<void>((resolve, reject) =>
          producer.beginTransaction((error) => (error ? reject(error) : resolve())),
        );
        for (const { record } of batch)
          producer.produce(
            this.#options.topic,
            this.#options.partition,
            Buffer.from(record.value),
            Buffer.from(record.sessionId),
            undefined,
            undefined,
            [{ "pi-cloud-fact-id": Buffer.from(record.factId) }],
          );
      });
      for (const pending of batch)
        pending.resolve({ factId: pending.record.factId, durable: true });
    } catch (error) {
      this.#failure = error;
      // No application-record retry after an ambiguous commit. A new producer
      // may serve later control work after fencing/aborting this incarnation.
      for (const pending of batch) pending.reject(error);
      for (const pending of this.#pending.splice(0))
        pending.reject(new PublicationNotSentError("Publication producer stopped before send"));
      await new Promise<void>((resolve) =>
        producer.abortTransaction(5000, (_error: LibrdKafkaError) => resolve()),
      );
      await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
      if (this.#producer === producer) this.#producer = undefined;
      if (!this.#closed && this.#options.current()) {
        try {
          await this.start();
        } catch (failure) {
          this.#failure = failure;
          this.#retryAfter = Date.now() + 1000;
        }
      }
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true;
      if (this.#timer) clearTimeout(this.#timer);
      for (const pending of this.#pending.splice(0))
        pending.reject(new PublicationNotSentError("Publication owner closed before send"));
      await this.#flushing;
      await this.#opening?.catch(() => {});
      const producer = this.#producer;
      this.#producer = undefined;
      if (producer)
        await new Promise<void>((resolve, reject) =>
          producer.disconnect((error) => (error ? reject(error) : resolve())),
        );
    })());
  }
}
