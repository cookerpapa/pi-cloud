import {
  Consumer,
  stringDeserializers,
  type Message,
  type MessagesStream,
} from "@platformatic/kafka";
import type { AcceptedFact } from "./accepted-fact.ts";
import { parseKafkaAcceptedFact } from "./kafka-accepted-fact.ts";

export type KafkaAcceptedFactRecord = Readonly<{
  fact: AcceptedFact;
  topic: string;
  partition: number;
  offset: bigint;
}>;

export class KafkaAcceptedFactConsumer {
  readonly #consumer: Consumer<string, string, string, string>;
  readonly #topic: string;
  readonly #handler: (record: KafkaAcceptedFactRecord) => Promise<void>;
  readonly #mode: "committed" | "earliest";
  #stream: MessagesStream<string, string, string, string> | undefined;
  #run: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    brokers: readonly string[];
    clientId: string;
    groupId: string;
    topic: string;
    mode: "committed" | "earliest";
    handler(record: KafkaAcceptedFactRecord): Promise<void>;
  }) {
    this.#topic = options.topic;
    this.#handler = options.handler;
    this.#mode = options.mode;
    this.#consumer = new Consumer({
      clientId: options.clientId,
      groupId: options.groupId,
      bootstrapBrokers: [...options.brokers],
      deserializers: stringDeserializers,
      autocommit: false,
      maxWaitTime: 100,
      highWaterMark: 256,
    });
  }

  async start(): Promise<void> {
    if (this.#run !== undefined) throw new Error("Kafka AcceptedFact consumer can only start once");
    this.#stream = await this.#consumer.consume({
      topics: [this.#topic],
      mode: this.#mode,
      fallbackMode: "earliest",
      autocommit: false,
      maxWaitTime: 100,
      highWaterMark: 256,
    });
    this.#run = this.#consume(this.#stream).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  checkHealth(): void {
    if (this.#run === undefined || this.#failure !== undefined || !this.#consumer.isActive()) {
      throw new Error("Kafka AcceptedFact consumer is unhealthy");
    }
  }

  async close(): Promise<void> {
    await this.#stream?.close().catch(() => undefined);
    await this.#run;
    await this.#consumer.close().catch(() => undefined);
    this.#stream = undefined;
    this.#run = undefined;
  }

  async #consume(stream: MessagesStream<string, string, string, string>): Promise<void> {
    for await (const message of stream) {
      await this.#handle(message);
      await message.commit();
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
