import kafkaNative from "@confluentinc/kafka-javascript";
import type { KafkaJS as KafkaTypes } from "@confluentinc/kafka-javascript";
import { operationalLog } from "@pi-cloud/observability";
const { KafkaJS, CODES } = kafkaNative;

export type KafkaPartitionBounds = Readonly<{ partition: number; low: bigint; high: bigint }>;

export type KafkaLogRecord<T> = Readonly<{
  fact: T;
  topic: string;
  partition: number;
  offset: bigint;
}>;

export type KafkaLogConsumerOptions<T> = {
  decode(value: string | Buffer): T;
  brokers: readonly string[];
  clientId: string;
  groupId: string;
  topic: string;
  commitMessages?: boolean;
  /** Router delivery resumes Kafka's committed group position, not a PG projection. */
  groupRecovery?: boolean;
  onReset?(): void;
  demandDriven?: boolean;
  onPartitionReset?(partition: number): void;
  replayOffsets?(
    bounds: readonly KafkaPartitionBounds[],
    partitionCount: number,
  ): Promise<ReadonlyMap<number, bigint | Error>>;
  handler(record: KafkaLogRecord<T>): Promise<void>;
};

/** librdkafka owns bounded buffering, assignments and partition flow control.
 * A failed record pauses/seeks ONLY its partition and returns the batch worker. */
export class KafkaLogConsumer<T> {
  readonly #options: KafkaLogConsumerOptions<T>;
  readonly #kafka: KafkaTypes.Kafka;
  #admin: KafkaTypes.Admin;
  #adminReady: Promise<void> | undefined;
  #consumer: KafkaTypes.Consumer | undefined;
  #run: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #closing = false;
  #ready = false;
  #epoch = 0;
  #failure: unknown;
  readonly #processedOffsets = new Map<number, bigint>();
  readonly #initialTargets = new Map<number, bigint>();
  readonly #retries = new Map<number, { since: number; count: number; timer: NodeJS.Timeout }>();
  readonly #inflight = new Map<Promise<void>, number>();
  readonly #references = new Map<number, number>();
  readonly #fetching = new Set<number>();
  readonly #activating = new Map<number, Promise<void>>();
  readonly #blocked = new Map<number, Error>();

  constructor(options: KafkaLogConsumerOptions<T>) {
    this.#options = options;
    this.#kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...options.brokers],
        clientId: options.clientId,
        logLevel: KafkaJS.logLevel.NOTHING,
      },
    });
    this.#admin = this.#kafka.admin();
  }

  async #bounds(): Promise<KafkaPartitionBounds[]> {
    if (!this.#adminReady) {
      const admin = this.#admin;
      this.#adminReady = admin.connect().catch(async (error) => {
        await admin.disconnect().catch(() => undefined);
        this.#admin = this.#kafka.admin();
        this.#adminReady = undefined;
        throw error;
      });
    }
    await this.#adminReady;
    // CreateTopics is acknowledged by the controller before every broker has
    // the new partition metadata. A fresh deployment must not fail in that gap.
    const deadline = Date.now() + 5000;
    let offsets: Awaited<ReturnType<KafkaTypes.Admin["fetchTopicOffsets"]>>;
    for (;;) {
      try {
        offsets = await this.#admin.fetchTopicOffsets(this.#options.topic);
        break;
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (
          this.#closing ||
          Date.now() >= deadline ||
          (code !== CODES.ERRORS.ERR_UNKNOWN_TOPIC_OR_PART &&
            code !== CODES.ERRORS.ERR_LEADER_NOT_AVAILABLE)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return offsets.map((p) => ({
      partition: p.partition,
      low: BigInt(p.low ?? 0),
      high: BigInt(p.high ?? p.offset),
    }));
  }

  async captureEndOffsets(): Promise<readonly bigint[]> {
    const bounds = await this.#bounds();
    const result: bigint[] = [];
    for (const b of bounds) {
      result[b.partition] = b.high;
      if (!this.#processedOffsets.has(b.partition)) this.#processedOffsets.set(b.partition, b.low);
    }
    return result;
  }

  async start(): Promise<void> {
    if (this.#run) throw new Error("Kafka consumer can only start once");
    this.#run = this.#runForever();
  }

  /** Bounded soft-state overflow uses the ordinary durable replay path. */
  requestReplay(): void {
    this.#ready = false;
    this.#epoch++;
    this.#wake?.();
  }

  async #runForever(): Promise<void> {
    while (!this.#closing) {
      let restart!: () => void;
      const interrupted = new Promise<void>((resolve) => {
        restart = resolve;
        this.#wake = resolve;
      });
      const consumer = this.#kafka.consumer({
        // PG owns recovery floors. Native offset commits run in the background.
        kafkaJS: {
          groupId: this.#options.groupId,
          fromBeginning: true,
          autoCommit: this.#options.commitMessages !== false,
          autoCommitInterval: 1000,
        },
        "partition.assignment.strategy": "range",
        "session.timeout.ms": 10_000,
        "heartbeat.interval.ms": 1_000,
        "queued.max.messages.kbytes": 32 * 1024,
        "queued.min.messages": 1,
        "fetch.queue.backoff.ms": 5,
        "fetch.wait.max.ms": 25,
        "fetch.max.bytes": 1024 * 1024,
        rebalance_cb: async (
          error: { code: number },
          assignments: Array<{ topic: string; partition: number; offset?: number }>,
          functions: {
            assign(value: Array<{ topic: string; partition: number; offset?: number }>): void;
            unassign(value: Array<{ topic: string; partition: number; offset?: number }>): void;
          },
        ) => {
          this.#epoch++;
          this.#ready = false;
          this.#fetching.clear();
          this.#blocked.clear();
          for (const retry of this.#retries.values()) clearTimeout(retry.timer);
          this.#retries.clear();
          if (error.code !== CODES.ERRORS.ERR__ASSIGN_PARTITIONS) {
            functions.unassign(assignments);
            return;
          }
          try {
            await Promise.allSettled([...this.#inflight.keys()]);
            this.#options.onReset?.();
            const allBounds = await this.#bounds();
            const bounds = allBounds.filter((b) =>
              assignments.some((a) => a.partition === b.partition),
            );
            const committed = this.#options.groupRecovery
              ? await this.#admin.fetchOffsets({
                  groupId: this.#options.groupId,
                  topics: [this.#options.topic],
                })
              : [];
            const groupOffsets = new Map(
              committed.flatMap((t) =>
                t.partitions.map((p) => [p.partition, BigInt(p.offset)] as const),
              ),
            );
            const offsets = this.#options.groupRecovery
              ? new Map(
                  bounds.map((b) => {
                    const saved = groupOffsets.get(b.partition) ?? -1n;
                    // The Tool router is not the recovery authority. Safe log
                    // reclamation has already closed/projected this prefix;
                    // an offline router must not require its deleted records.
                    const offset = saved < b.low ? b.low : saved;
                    return [
                      b.partition,
                      offset > b.high
                        ? new Error("Kafka group delivery position is outside retention")
                        : offset,
                    ] as const;
                  }),
                )
              : this.#options.replayOffsets
                ? new Map(await this.#options.replayOffsets(bounds, allBounds.length))
                : new Map(bounds.map((b) => [b.partition, b.low]));
            for (const b of bounds) {
              const offset = offsets.get(b.partition)!;
              if (offset instanceof Error) this.#blocked.set(b.partition, offset);
              this.#processedOffsets.set(b.partition, offset instanceof Error ? b.low : offset);
              this.#initialTargets.set(b.partition, b.high);
            }
            functions.assign(
              assignments.map((a) => ({
                ...a,
                offset: Number(
                  this.#blocked.has(a.partition)
                    ? bounds.find((b) => b.partition === a.partition)!.high
                    : offsets.get(a.partition),
                ),
              })),
            );
            const idle = assignments
              .filter(
                (a) =>
                  this.#blocked.has(a.partition) ||
                  (this.#options.demandDriven && !this.#references.has(a.partition)),
              )
              .map((a) => a.partition);
            if (idle.length) consumer.pause([{ topic: this.#options.topic, partitions: idle }]);
            for (const a of assignments)
              if (!idle.includes(a.partition)) this.#fetching.add(a.partition);
            this.#failure = undefined;
            this.#ready = true;
          } catch (failure) {
            // The native callback otherwise falls back to default assignment.
            // Never consume from an unverified recovery position after an error.
            functions.assign([]);
            this.#failure = failure;
            restart();
          }
        },
      });
      this.#consumer = consumer;
      try {
        const partitions = (await this.#bounds()).length;
        await consumer.connect();
        await consumer.subscribe({ topics: [this.#options.topic] });
        await consumer.run({
          partitionsConsumedConcurrently: Math.max(1, partitions),
          eachBatchAutoResolve: false,
          eachBatch: (payload) => {
            const task = this.#batch(consumer, payload, this.#epoch);
            this.#inflight.set(task, payload.batch.partition);
            void task.finally(() => this.#inflight.delete(task)).catch(() => undefined);
            return task;
          },
        });
        await interrupted;
      } catch (error) {
        this.#failure = error;
      } finally {
        this.#ready = false;
        this.#epoch++;
        for (const retry of this.#retries.values()) clearTimeout(retry.timer);
        this.#retries.clear();
        await consumer.disconnect().catch(() => undefined);
      }
      if (!this.#closing) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async #batch(
    consumer: KafkaTypes.Consumer,
    payload: KafkaTypes.EachBatchPayload,
    epoch: number,
  ): Promise<void> {
    const { batch } = payload;
    if (this.#closing || epoch !== this.#epoch || payload.isStale() || !this.#ready) return;
    if (
      this.#blocked.has(batch.partition) ||
      (this.#options.demandDriven && !this.#fetching.has(batch.partition))
    ) {
      consumer.pause([{ topic: batch.topic, partitions: [batch.partition] }]);
      consumer.seek({
        topic: batch.topic,
        partition: batch.partition,
        offset: batch.messages[0]!.offset,
      });
      return;
    }
    for (const message of batch.messages) {
      if (this.#closing || epoch !== this.#epoch || payload.isStale() || !this.#ready) return;
      try {
        if (message.value === null) throw new Error("AcceptedFact cannot be a Kafka tombstone");
        const fact = this.#options.decode(message.value);
        await this.#options.handler({
          fact,
          topic: batch.topic,
          partition: batch.partition,
          offset: BigInt(message.offset),
        });
        if (epoch !== this.#epoch || payload.isStale()) return;
        payload.resolveOffset(message.offset);
        this.#processedOffsets.set(batch.partition, BigInt(message.offset) + 1n);
        const retry = this.#retries.get(batch.partition);
        if (retry) {
          clearTimeout(retry.timer);
          this.#retries.delete(batch.partition);
        }
      } catch (error) {
        if (this.#closing || epoch !== this.#epoch || payload.isStale()) return;
        const previous = this.#retries.get(batch.partition);
        const since = previous?.since ?? Date.now(),
          count = (previous?.count ?? 0) + 1;
        if (!previous)
          operationalLog({
            service: "pi-cloud-kafka-consumer",
            level: "error",
            event: "partition.stalled",
            attributes: { topic: batch.topic, partition: batch.partition },
          });
        consumer.pause([{ topic: batch.topic, partitions: [batch.partition] }]);
        consumer.seek({ topic: batch.topic, partition: batch.partition, offset: message.offset });
        const timer = setTimeout(
          () => {
            if (
              !this.#closing &&
              epoch === this.#epoch &&
              (!this.#options.demandDriven || this.#fetching.has(batch.partition))
            )
              consumer.resume([{ topic: batch.topic, partitions: [batch.partition] }]);
          },
          Math.min(1000, 25 * 2 ** Math.min(count - 1, 6)),
        );
        timer.unref();
        this.#retries.set(batch.partition, { since, count, timer });
        break;
      }
    }
  }

  checkHealth(): void {
    if (
      !this.#ready ||
      this.#failure !== undefined ||
      this.#blocked.size > 0 ||
      [...this.#retries.values()].some((r) => Date.now() - r.since > 5000)
    )
      throw new Error("Kafka AcceptedFact consumer is unhealthy");
  }

  async waitUntilAssigned(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#closing && Date.now() < deadline) {
      if (this.#ready && this.#blocked.size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Kafka consumer group assignment is unavailable");
  }

  async waitUntilInitialReplay(offsets: readonly bigint[], timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.#closing && Date.now() < end) {
      if (
        this.#ready &&
        this.#blocked.size === 0 &&
        offsets.every((v, p) => (this.#processedOffsets.get(p) ?? 0n) >= v)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Kafka replay did not reach its startup boundary");
  }

  async waitForPartition(partition: number, timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.#closing && Date.now() < end) {
      const target = this.#initialTargets.get(partition);
      if (this.#blocked.has(partition)) throw this.#blocked.get(partition)!;
      if (
        this.#ready &&
        target !== undefined &&
        (this.#processedOffsets.get(partition) ?? 0n) >= target
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Session partition replay is unavailable");
  }

  async partitionCount(): Promise<number> {
    return (await this.#bounds()).length;
  }

  async retainPartition(partition: number): Promise<() => void> {
    this.#references.set(partition, (this.#references.get(partition) ?? 0) + 1);
    const release = () => {
      const left = (this.#references.get(partition) ?? 1) - 1;
      if (left > 0) this.#references.set(partition, left);
      else {
        this.#references.delete(partition);
        this.#fetching.delete(partition);
        if (this.#ready && !this.#closing)
          this.#consumer?.pause([{ topic: this.#options.topic, partitions: [partition] }]);
        // No browser owns this soft tail. Drop it after outstanding handlers
        // quiesce; a later subscriber reconstructs from the durable recovery floor.
        void Promise.allSettled(
          [...this.#inflight].filter(([, p]) => p === partition).map(([task]) => task),
        ).then(() => {
          if (!this.#references.has(partition) && !this.#fetching.has(partition))
            this.#options.onPartitionReset?.(partition);
        });
      }
    };
    try {
      let activation = this.#activating.get(partition);
      if (!activation) {
        activation = this.#activate(partition);
        this.#activating.set(partition, activation);
        void activation.finally(() => this.#activating.delete(partition)).catch(() => undefined);
      }
      await activation;
      await this.waitForPartition(partition);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          release();
        }
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  async #activate(partition: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (!this.#ready && !this.#closing && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    if (!this.#ready || !this.#consumer) throw new Error("Kafka live partition is unavailable");
    if (this.#fetching.has(partition)) return;
    const epoch = this.#epoch,
      consumer = this.#consumer;
    await Promise.allSettled(
      [...this.#inflight].filter(([, p]) => p === partition).map(([task]) => task),
    );
    const allBounds = await this.#bounds(),
      bounds = allBounds.filter((b) => b.partition === partition);
    const offsets = this.#options.replayOffsets
      ? await this.#options.replayOffsets(bounds, allBounds.length)
      : new Map(bounds.map((b) => [b.partition, b.low]));
    if (epoch !== this.#epoch) throw new Error("Kafka assignment changed while opening Session");
    this.#options.onPartitionReset?.(partition);
    const offset = offsets.get(partition)!;
    if (offset instanceof Error) throw offset;
    this.#blocked.delete(partition);
    this.#processedOffsets.set(partition, offset);
    this.#initialTargets.set(partition, bounds[0]!.high);
    consumer.seek({ topic: this.#options.topic, partition, offset: offset.toString() });
    this.#fetching.add(partition);
    consumer.resume([{ topic: this.#options.topic, partitions: [partition] }]);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#epoch++;
    this.#wake?.();
    await this.#run;
    if (this.#adminReady) await this.#admin.disconnect();
    this.#consumer = undefined;
  }
}
