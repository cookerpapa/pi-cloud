import kafkaNative from "@confluentinc/kafka-javascript";
import type {
  KafkaJS as K,
  KafkaConsumer,
  LibrdKafkaError,
  Message,
  Producer,
} from "@confluentinc/kafka-javascript";

type Assignment = { topic: string; partition: number; offset?: number };
export type PartitionReaderOptions = {
  brokers: readonly string[];
  clientId: string;
  groupId: string;
  topic: string;
  logger: K.Logger;
  rebalance(
    error: { code: number },
    assignments: Assignment[],
    functions: {
      assign(value: Assignment[]): void;
      unassign(value: Assignment[]): void;
    },
  ): Promise<void>;
  /** Emitted only after every delivered record preceding this EOF has settled. */
  onPosition(partition: number, offset: bigint): void;
};

/** Pinned librdkafka's public native API exposes EOF, including transaction gaps.
 * One delivered record per partition is in flight; native pause owns buffering.
 */
export class KafkaPartitionReader {
  readonly #client: KafkaConsumer;
  readonly #options: PartitionReaderOptions;
  readonly #assigned = new Set<number>();
  readonly #active = new Map<number, Promise<void>>();
  readonly #paused = new Set<number>();
  readonly #epochs = new Map<number, number>();
  readonly #eof = new Map<number, { offset: bigint; epoch: number }>();
  readonly #starts = new Map<number, number>();
  readonly #committed = new Map<number, bigint>();
  readonly #commitLocks = new Map<number, Promise<void>>();
  #generation = 0;
  #closing = false;
  #disconnecting: Promise<void> | undefined;
  #connected = false;
  #polling = false;
  #pollGeneration = 0;
  #loop: Promise<void> | undefined;
  #handler: K.EachBatchHandler | undefined;
  #commitTail = Promise.resolve();
  #commit:
    | {
        offsets: K.TopicPartitionOffsetAndMetadata[];
        resolve(): void;
        reject(error: unknown): void;
      }
    | undefined;

  constructor(options: PartitionReaderOptions) {
    this.#options = options;
    this.#client = new kafkaNative.KafkaConsumer({
      "metadata.broker.list": options.brokers.join(","),
      "client.id": options.clientId,
      "group.id": options.groupId,
      "enable.auto.commit": false,
      "enable.auto.offset.store": false,
      "enable.partition.eof": true,
      "isolation.level": "read_committed",
      "partition.assignment.strategy": "range",
      "allow.auto.create.topics": false,
      "session.timeout.ms": 10_000,
      "heartbeat.interval.ms": 1_000,
      "queued.max.messages.kbytes": 32 * 1024,
      "queued.min.messages": 1,
      "fetch.queue.backoff.ms": 5,
      "fetch.wait.max.ms": 25,
      "fetch.max.bytes": 1024 * 1024,
      offset_commit_cb: true,
      rebalance_cb: (error: LibrdKafkaError, assignments: Assignment[]) => {
        this.#generation++;
        this.#assigned.clear();
        this.#starts.clear();
        this.#committed.clear();
        this.#eof.clear();
        this.#paused.clear();
        const generation = this.#generation;
        void options
          .rebalance(error, assignments, {
            assign: (values) => {
              if (this.#closing || generation !== this.#generation) return;
              this.#client.assign(values);
              // librdkafka preserves pause state for a retained partition.
              // Its old-generation handler deliberately cannot resume it;
              // reset transport pauses when the new assignment is installed.
              // Recovery may explicitly pause blocked partitions afterwards.
              if (values.length) this.#client.resume(values);
              for (const value of values) {
                this.#assigned.add(value.partition);
                if (value.offset !== undefined) this.#starts.set(value.partition, value.offset);
              }
            },
            unassign: () => {
              this.#client.unassign();
            },
          })
          .catch((failure) => this.#fail(failure));
      },
    });
    this.#client.setDefaultConsumeTimeout(25);
    this.#client.on("event.error", (error) => {
      if (!this.#closing) this.#fail(error);
    });
    this.#client.on("partition.eof", (event) => {
      if (
        this.#closing ||
        !this.#polling ||
        this.#pollGeneration !== this.#generation ||
        !this.#assigned.has(event.partition) ||
        event.offset < 0
      )
        return;
      this.#eof.set(event.partition, {
        offset: BigInt(event.offset),
        epoch: this.#epoch(event.partition),
      });
      this.#advance(event.partition);
    });
    this.#client.on("offset.commit", (error, offsets) => {
      const pending = this.#commit;
      if (!pending) return;
      if (error) {
        pending.reject(error);
        return;
      }
      if (
        pending.offsets.every((wanted) =>
          offsets.some(
            (actual) =>
              actual.topic === wanted.topic &&
              actual.partition === wanted.partition &&
              BigInt(actual.offset) >= BigInt(wanted.offset),
          ),
        )
      )
        pending.resolve();
    });
  }

  #fail(error: unknown): void {
    this.#options.logger.error(error instanceof Error ? error.name : "KafkaReaderError");
  }

  #epoch(partition: number): number {
    return this.#epochs.get(partition) ?? 0;
  }

  #advance(partition: number): void {
    const eof = this.#eof.get(partition);
    if (
      this.#polling ||
      this.#active.has(partition) ||
      !eof ||
      eof.epoch !== this.#epoch(partition) ||
      !this.#assigned.has(partition)
    )
      return;
    this.#options.onPosition(partition, eof.offset);
    this.#eof.delete(partition);
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#client.connect({}, (error) => {
        if (error) reject(error);
        else {
          this.#connected = true;
          resolve();
        }
      }),
    );
  }

  async subscribe(input: K.ConsumerSubscribeTopics): Promise<void> {
    this.#client.subscribe(input.topics);
  }

  async run(input: K.ConsumerRunConfig): Promise<void> {
    if (this.#loop || !input.eachBatch)
      throw new Error("Kafka partition reader requires one batch handler");
    this.#handler = input.eachBatch;
    this.#loop = this.#poll().catch((error) => {
      if (!this.#closing) this.#fail(error);
    });
  }

  async #poll(): Promise<void> {
    while (!this.#closing) {
      const generation = this.#generation;
      this.#pollGeneration = generation;
      this.#polling = true;
      let messages: Message[];
      try {
        messages = await new Promise<Message[]>((resolve, reject) =>
          this.#client.consume(1, (error, values) => (error ? reject(error) : resolve(values))),
        );
      } finally {
        this.#polling = false;
      }
      if (!this.#closing && generation === this.#generation) {
        for (const message of messages) this.#deliver(message);
        for (const partition of this.#eof.keys()) this.#advance(partition);
      } else if (!this.#closing) {
        // A poll can span assignment. No new-generation record has been delivered
        // by this single poller yet; rewind its new assignments rather than drop
        // a first record returned while the callback was installing them.
        for (const [partition, offset] of this.#starts)
          this.seek({ topic: this.#options.topic, partition, offset: String(offset) });
      }
      if (!messages.length) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  #deliver(message: Message): void {
    const partition = message.partition,
      generation = this.#generation,
      epoch = this.#epoch(partition);
    if (!this.#assigned.has(partition)) return;
    // pause is synchronous: no second record of this partition is handed to us
    // until its handler finishes or explicitly seeks/retries it.
    if (this.#active.has(partition))
      throw Object.assign(new Error("Kafka delivered a paused partition twice"), {
        name: "KafkaPausedPartitionDeliveryError",
      });
    this.#client.pause([{ topic: message.topic, partition }]);
    const current = () =>
      !this.#closing && generation === this.#generation && epoch === this.#epoch(partition);
    const record: K.KafkaMessage = {
      key: typeof message.key === "string" ? Buffer.from(message.key) : (message.key ?? null),
      value: message.value,
      timestamp: String(message.timestamp ?? 0),
      attributes: 0,
      offset: String(message.offset),
      headers: Object.assign({}, ...(message.headers ?? [])),
    };
    const task = Promise.resolve()
      .then(() =>
        this.#handler!({
          batch: {
            topic: message.topic,
            partition,
            highWatermark: String(message.offset + 1),
            messages: [record],
            isEmpty: () => false,
            firstOffset: () => String(message.offset),
            lastOffset: () => String(message.offset),
            offsetLag: () => "0",
            offsetLagLow: () => "0",
          },
          isRunning: () => !this.#closing,
          isStale: () => !current(),
          resolveOffset: (offset) => {
            if (current())
              this.#client.offsetsStore([
                { topic: message.topic, partition, offset: Number(BigInt(offset) + 1n) },
              ]);
          },
          heartbeat: async () => {},
          pause: () => {
            this.pause([{ topic: message.topic, partitions: [partition] }]);
            return () => this.resume([{ topic: message.topic, partitions: [partition] }]);
          },
          commitOffsetsIfNecessary: async () => {},
        }),
      )
      .catch((error) => this.#fail(error))
      .finally(() => {
        if (this.#active.get(partition) !== task) return;
        this.#active.delete(partition);
        if (current()) {
          this.#advance(partition);
          if (!this.#paused.has(partition))
            this.#client.resume([{ topic: message.topic, partition }]);
        }
      });
    this.#active.set(partition, task);
  }

  pause(topics: K.TopicPartitions[]): void {
    const partitions = topics.flatMap((topic) =>
      topic.partitions.map((partition) => ({ topic: topic.topic, partition })),
    );
    for (const { partition } of partitions) this.#paused.add(partition);
    this.#client.pause(partitions);
  }

  resume(topics: K.TopicPartitions[]): void {
    const partitions = topics.flatMap((topic) =>
      topic.partitions.map((partition) => ({ topic: topic.topic, partition })),
    );
    for (const { partition } of partitions) this.#paused.delete(partition);
    this.#client.resume(partitions.filter(({ partition }) => !this.#active.has(partition)));
  }

  seek(position: K.TopicPartitionOffset): void {
    this.#epochs.set(position.partition, this.#epoch(position.partition) + 1);
    this.#eof.delete(position.partition);
    this.#client.seek({ ...position, offset: Number(position.offset) }, 5000, (error) => {
      if (error && !this.#closing) this.#fail(error);
    });
  }

  commitOffset(position: K.TopicPartitionOffsetAndMetadata): Promise<void> {
    if (this.#closing) return Promise.reject(new Error("Kafka consumer is closing"));
    const offset = { ...position },
      generation = this.#generation;
    // A partition waiting for its publication never reserves another partition
    // or the shared native commit callback. Only actual callback receipts serialize.
    return this.#withCommitLock(offset.partition, () => {
      const pending = this.#commitTail.then(async () => {
        if (
          this.#closing ||
          generation !== this.#generation ||
          !this.#assigned.has(offset.partition)
        )
          throw new Error("Kafka commit owner changed");
        if (BigInt(offset.offset) <= (this.#committed.get(offset.partition) ?? -1n)) return;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error("Kafka dispatch commit acknowledgement timed out");
            this.#fail(error);
            finish(error);
          }, 5000);
          const finish = (error?: unknown) => {
            clearTimeout(timer);
            this.#commit = undefined;
            if (error) reject(error);
            else resolve();
          };
          this.#commit = { offsets: [offset], resolve: () => finish(), reject: finish };
          try {
            this.#client.commit([{ ...offset, offset: Number(offset.offset) }]);
          } catch (error) {
            finish(error);
          }
        });
        if (generation === this.#generation)
          this.#committed.set(offset.partition, BigInt(offset.offset));
      });
      this.#commitTail = pending.catch(() => {});
      return pending;
    });
  }

  seedCommitted(offsets: ReadonlyMap<number, bigint>): void {
    for (const [partition, offset] of offsets)
      this.#committed.set(partition, offset < 0n ? 0n : offset);
  }

  async #withCommitLock<T>(partition: number, run: () => Promise<T>): Promise<T> {
    const previous = this.#commitLocks.get(partition) ?? Promise.resolve();
    const next = Promise.withResolvers<void>();
    const tail = previous.then(() => next.promise);
    this.#commitLocks.set(partition, tail);
    await previous;
    try {
      return await run();
    } finally {
      next.resolve();
      if (this.#commitLocks.get(partition) === tail) this.#commitLocks.delete(partition);
    }
  }

  /** Couple publication commit to the current group member, without advancing
   * or regressing the Projector's independent effect-dispatch offset. */
  async commitPublication(
    partition: number,
    producer: Producer,
    send: () => Promise<void>,
  ): Promise<void> {
    if (this.#closing) throw new Error("Kafka consumer is closing");
    const generation = this.#generation;
    await this.#withCommitLock(partition, async () => {
      if (this.#closing || generation !== this.#generation || !this.#assigned.has(partition))
        throw new Error("Publication partition assignment changed");
      const offset = this.#committed.get(partition);
      if (offset === undefined) throw new Error("Publication dispatch boundary is not initialized");
      await send();
      if (this.#closing || generation !== this.#generation || !this.#assigned.has(partition))
        throw new Error("Publication owner changed before transaction commit");
      await new Promise<void>((resolve, reject) =>
        producer.sendOffsetsToTransaction(
          [{ topic: this.#options.topic, partition, offset: Number(offset) }],
          this.#client,
          5000,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      if (this.#closing || generation !== this.#generation || !this.#assigned.has(partition))
        throw new Error("Publication owner changed during group transaction");
      await new Promise<void>((resolve, reject) =>
        producer.commitTransaction(5000, (error) => (error ? reject(error) : resolve())),
      );
    });
  }

  disconnect(): Promise<void> {
    return (this.#disconnecting ??= this.#disconnect());
  }

  async #disconnect(): Promise<void> {
    this.#closing = true;
    this.#generation++;
    this.#commit?.reject(new Error("Kafka consumer stopped during commit"));
    await this.#loop;
    await Promise.allSettled([...this.#active.values()]);
    await this.#commitTail;
    // Session seal writers are external to KafkaLogConsumer's partition writer
    // set. Every group transaction borrows this native client through these
    // locks, so join them before disposal even during consumer-only restart.
    await Promise.allSettled([...this.#commitLocks.values()]);
    if (this.#connected)
      await new Promise<void>((resolve, reject) =>
        this.#client.disconnect((error) => (error ? reject(error) : resolve())),
      );
  }
}
