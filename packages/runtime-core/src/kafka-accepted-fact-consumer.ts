import {
  Consumer,
  stringDeserializers,
  type Message,
  type MessagesStream,
} from "@platformatic/kafka";
import type { AcceptedFact } from "./accepted-fact.ts";
import { parseKafkaAcceptedFact } from "./kafka-accepted-fact.ts";
import { consumePartitioned } from "./partitioned-consumption.ts";

export type KafkaAcceptedFactRecord = Readonly<{
  fact: AcceptedFact;
  topic: string;
  partition: number;
  offset: bigint;
}>;

export class KafkaAcceptedFactConsumer {
  #consumer: Consumer<string, string, string, string>;
  readonly #configuration: Readonly<{
    brokers: readonly string[];
    clientId: string;
    groupId: string;
  }>;
  readonly #topic: string;
  readonly #handler: (record: KafkaAcceptedFactRecord) => Promise<void>;
  readonly #mode: "committed" | "earliest";
  readonly #commitMessages: boolean;
  readonly #commitEvery: number;
  #stream: MessagesStream<string, string, string, string> | undefined;
  #run: Promise<void> | undefined;
  #failure: unknown;
  #closing = false;
  readonly #processedOffsets = new Map<number, bigint>();

  constructor(options: {
    brokers: readonly string[];
    clientId: string;
    groupId: string;
    topic: string;
    mode: "committed" | "earliest";
    commitMessages?: boolean;
    commitEvery?: number;
    handler(record: KafkaAcceptedFactRecord): Promise<void>;
  }) {
    this.#topic = options.topic;
    this.#handler = options.handler;
    this.#mode = options.mode;
    this.#commitMessages = options.commitMessages ?? true;
    this.#commitEvery = options.commitEvery ?? 1;
    if (!Number.isSafeInteger(this.#commitEvery) || this.#commitEvery < 1) {
      throw new TypeError("Kafka consumer commitEvery is invalid");
    }
    this.#configuration = {
      brokers: options.brokers,
      clientId: options.clientId,
      groupId: options.groupId,
    };
    this.#consumer = this.#createConsumer();
  }

  #createConsumer(): Consumer<string, string, string, string> {
    return new Consumer({
      clientId: this.#configuration.clientId,
      groupId: this.#configuration.groupId,
      bootstrapBrokers: [...this.#configuration.brokers],
      deserializers: stringDeserializers,
      autocommit: false,
      maxWaitTime: 100,
      highWaterMark: 256,
      groupProtocol: "classic",
      sessionTimeout: 10_000,
      heartbeatInterval: 1_000,
      rebalanceTimeout: 30_000,
    });
  }

  async start(): Promise<void> {
    if (this.#run !== undefined) throw new Error("Kafka AcceptedFact consumer can only start once");
    this.#run = this.#runForever();
  }

  async #openAndConsume(): Promise<void> {
    this.#stream = await this.#consumer.consume({
      topics: [this.#topic],
      mode: this.#mode,
      fallbackMode: "earliest",
      autocommit: false,
      maxWaitTime: 100,
      highWaterMark: 256,
      groupProtocol: "classic",
      sessionTimeout: 10_000,
      heartbeatInterval: 1_000,
      rebalanceTimeout: 30_000,
    });
    this.#failure = undefined;
    await this.#consume(this.#stream);
  }

  async #runForever(): Promise<void> {
    let delayMs = 100;
    while (!this.#closing) {
      try {
        await this.#openAndConsume();
        if (!this.#closing) throw new Error("Kafka AcceptedFact consumer ended unexpectedly");
      } catch (error: unknown) {
        if (this.#closing) return;
        this.#failure = error;
        await this.#stream?.close().catch(() => undefined);
        await this.#consumer.close().catch(() => undefined);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(5_000, delayMs * 2);
        this.#stream = undefined;
        this.#consumer = this.#createConsumer();
      }
    }
  }

  checkHealth(): void {
    if (this.#run === undefined || this.#failure !== undefined || !this.#consumer.isActive()) {
      throw new Error("Kafka AcceptedFact consumer is unhealthy");
    }
  }

  async captureEndOffsets(): Promise<readonly bigint[]> {
    const starts = (
      await this.#consumer.listOffsets({ topics: [this.#topic], timestamp: -2n })
    ).get(this.#topic);
    if (starts === undefined) {
      throw new Error("Kafka AcceptedFact Topic start offsets are unavailable");
    }
    starts.forEach((offset, partition) => this.#processedOffsets.set(partition, offset));
    const ends = (await this.#consumer.listOffsets({ topics: [this.#topic] })).get(this.#topic);
    if (ends === undefined) throw new Error("Kafka AcceptedFact Topic end offsets are unavailable");
    return ends;
  }

  async waitUntilInitialReplay(offsets: readonly bigint[], timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        offsets.every(
          (target, partition) =>
            target === 0n || (this.#processedOffsets.get(partition) ?? 0n) >= target,
        )
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Kafka Gateway live-tail replay did not reach its startup boundary");
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#stream?.close().catch(() => undefined);
    await this.#consumer.close().catch(() => undefined);
    await this.#run;
    this.#stream = undefined;
    this.#run = undefined;
  }

  async #consume(stream: MessagesStream<string, string, string, string>): Promise<void> {
    const uncommitted = new Map<
      number,
      { count: number; last: Message<string, string, string, string> }
    >();
    const generation = new AbortController();
    const stop = () => generation.abort();
    stream.once("close", stop);
    try {
      await consumePartitioned(stream, async (message) => {
        let delayMs = 50;
        while (!this.#closing && !generation.signal.aborted) {
          try {
            await this.#handle(message);
            if (this.#closing || generation.signal.aborted) return;
            this.#processedOffsets.set(message.partition, message.offset + 1n);
            if (this.#commitMessages) {
              const count = (uncommitted.get(message.partition)?.count ?? 0) + 1;
              uncommitted.set(message.partition, { count, last: message });
              if (count >= this.#commitEvery) {
                await message.commit();
                uncommitted.delete(message.partition);
              }
            }
            break;
          } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            delayMs = Math.min(1_000, delayMs * 2);
          }
        }
      });
      if (!this.#closing && !generation.signal.aborted) {
        await Promise.all([...uncommitted.values()].map(({ last }) => last.commit()));
      }
    } finally {
      stream.off("close", stop);
    }
  }

  async #handle(message: Message<string, string, string, string>): Promise<void> {
    await this.#handler({
      fact: parseKafkaAcceptedFact(message.value),
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    });
  }
}
