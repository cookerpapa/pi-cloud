import { createHash } from "node:crypto";
import kafkaNative, { type Producer } from "@confluentinc/kafka-javascript";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { KafkaPublicationRecord } from "./kafka-publication-writer.ts";

export function sessionTransactionalId(topic: string, tenantId: string, sessionId: string): string {
  return `pi-session-${createHash("sha256")
    .update(JSON.stringify([topic, tenantId, sessionId]))
    .digest("hex")}`;
}
export type SessionTransaction = (producer: Producer, send: () => Promise<void>) => Promise<void>;

/** A single Session incarnation gets one initialization attempt. Any uncertain
 * commit or producer fencing ends this writer; only PG-authorized recovery may
 * create another one. Model/Tool waits never hold an open Kafka transaction. */
export class KafkaSessionWriter {
  #producer: Producer | undefined;
  #opening: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closed = false;
  #closing: Promise<void> | undefined;
  get failure(): unknown {
    return this.#failure;
  }
  constructor(
    readonly options: {
      brokers: readonly string[];
      clientId: string;
      topic: string;
      partition: number;
      tenantId: string;
      sessionId: string;
      authorize(phase: "before_init" | "after_init"): Promise<void>;
      current(): boolean;
      transaction?: SessionTransaction;
    },
  ) {}

  start(): Promise<void> {
    if (this.#closed)
      return Promise.reject(new PublicationNotSentError("Session producer is closed"));
    return (this.#opening ??= this.#open().catch((error) => {
      this.#failure = error;
      throw error;
    }));
  }
  async #open(): Promise<void> {
    if (!this.options.current())
      throw new PublicationNotSentError("Session owner changed before initialization");
    await this.options.authorize("before_init");
    if (this.#closed || !this.options.current())
      throw new PublicationNotSentError("Session owner changed before initialization");
    const producer = new kafkaNative.Producer({
      "metadata.broker.list": this.options.brokers.join(","),
      "client.id": this.options.clientId,
      "transactional.id": sessionTransactionalId(
        this.options.topic,
        this.options.tenantId,
        this.options.sessionId,
      ),
      "enable.idempotence": true,
      acks: -1,
      "transaction.timeout.ms": 15_000,
      "queue.buffering.max.messages": 4096,
      "queue.buffering.max.kbytes": 65536,
      "linger.ms": 1,
      "retry.backoff.ms": 5,
      "retry.backoff.max.ms": 1000,
      "allow.auto.create.topics": false,
    });
    producer.on("event.error", () => {
      /* send/commit owns error classification */
    });
    try {
      await new Promise<void>((resolve, reject) =>
        producer.connect({ topic: this.options.topic, timeout: 5000 }, (e) =>
          e ? reject(e) : resolve(),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        producer.initTransactions(10_000, (e) => (e ? reject(e) : resolve())),
      );
      // This fresh read is essential: an obsolete initializer can fence another
      // producer before returning. A pre-initialization check alone is unsafe.
      await this.options.authorize("after_init");
      if (this.#closed || !this.options.current())
        throw new PublicationNotSentError("Session owner changed during initialization");
      producer.setPollInterval(10);
      this.#producer = producer;
    } catch (error) {
      await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
      throw error;
    }
  }
  append(record: KafkaPublicationRecord): Promise<{ factId: string; durable: true }> {
    if (this.#closed || this.#failure || !this.#producer || !this.options.current())
      return Promise.reject(new PublicationNotSentError("Session producer is not admitted"));
    const pending = this.#tail.then(async () => {
      if (this.#failure || this.#closed || !this.options.current())
        throw new PublicationNotSentError("Session producer retired before send");
      const producer = this.#producer!;
      try {
        const send = async () => {
          await new Promise<void>((resolve, reject) =>
            producer.beginTransaction((e) => (e ? reject(e) : resolve())),
          );
          producer.produce(
            this.options.topic,
            this.options.partition,
            Buffer.from(record.value),
            Buffer.from(record.sessionId),
            undefined,
            undefined,
            [{ "pi-cloud-fact-id": Buffer.from(record.factId) }],
          );
        };
        if (this.options.transaction) await this.options.transaction(producer, send);
        else {
          await send();
          await new Promise<void>((resolve, reject) =>
            producer.commitTransaction(10_000, (e) => (e ? reject(e) : resolve())),
          );
        }
        return { factId: record.factId, durable: true as const };
      } catch (error) {
        this.#failure = error;
        await new Promise<void>((resolve) => producer.abortTransaction(3000, () => resolve()));
        throw error;
      }
    });
    this.#tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true;
      await this.#opening?.catch(() => {});
      await this.#tail;
      const producer = this.#producer;
      this.#producer = undefined;
      if (producer) await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
    })());
  }
}
