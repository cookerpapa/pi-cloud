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
  /** Include completed delivery as well as the durable projection recovery floor. */
  groupRecovery?: boolean;
  onReset?(): void;
  replayOffsets?(
    bounds: readonly KafkaPartitionBounds[],
    partitionCount: number,
  ): Promise<ReadonlyMap<number, bigint | Error>>;
  handler(record: KafkaLogRecord<T>, current?: () => boolean): Promise<void>;
};

/** librdkafka owns bounded buffering, assignments and partition flow control.
 * A failed record pauses/seeks ONLY its partition and returns the batch worker. */
export class KafkaLogConsumer<T> {
  readonly #options: KafkaLogConsumerOptions<T>;
  readonly #kafka: KafkaTypes.Kafka;
  #admin: KafkaTypes.Admin;
  #adminReady: Promise<void> | undefined;
  #run: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #closing = false;
  #ready = false;
  #epoch = 0;
  #failure: unknown;
  readonly #processedOffsets = new Map<number, bigint>();
  readonly #initialTargets = new Map<number, bigint>();
  readonly #retries = new Map<number, { since: number; count: number; timer: NodeJS.Timeout }>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #assigned = new Set<number>();
  readonly #blocked = new Map<number, Error>();
  #memberCache: { until: number; owners: Map<number, string> } | undefined;

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
          this.#assigned.clear();
          this.#blocked.clear();
          for (const retry of this.#retries.values()) clearTimeout(retry.timer);
          this.#retries.clear();
          if (error.code !== CODES.ERRORS.ERR__ASSIGN_PARTITIONS) {
            this.#options.onReset?.();
            functions.unassign(assignments);
            return;
          }
          try {
            await Promise.allSettled([...this.#inflight]);
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
            const offsets: Map<number, bigint | Error> = this.#options.groupRecovery
              ? new Map(
                  bounds.map((b) => {
                    const saved = groupOffsets.get(b.partition) ?? -1n;
                    // Safe reclamation has already closed/projected this prefix.
                    // Completed group delivery can lag that reclaimed position.
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
            if (this.#options.groupRecovery && this.#options.replayOffsets) {
              const recovery = await this.#options.replayOffsets(bounds, allBounds.length);
              for (const [partition, floor] of recovery) {
                const delivery = offsets.get(partition)!;
                offsets.set(
                  partition,
                  floor instanceof Error
                    ? floor
                    : delivery instanceof Error
                      ? delivery
                      : floor < delivery
                        ? floor
                        : delivery,
                );
              }
            }
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
            const blocked = assignments
              .filter((a) => this.#blocked.has(a.partition))
              .map((a) => a.partition);
            if (blocked.length)
              consumer.pause([{ topic: this.#options.topic, partitions: blocked }]);
            for (const a of assignments)
              if (!this.#blocked.has(a.partition)) this.#assigned.add(a.partition);
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
      try {
        const partitions = (await this.#bounds()).length;
        await consumer.connect();
        await consumer.subscribe({ topics: [this.#options.topic] });
        await consumer.run({
          partitionsConsumedConcurrently: Math.max(1, partitions),
          eachBatchAutoResolve: false,
          eachBatch: (payload) => {
            const task = this.#batch(consumer, payload, this.#epoch);
            this.#inflight.add(task);
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
    if (this.#blocked.has(batch.partition)) {
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
        await this.#options.handler(
          {
            fact,
            topic: batch.topic,
            partition: batch.partition,
            offset: BigInt(message.offset),
          },
          () => !this.#closing && epoch === this.#epoch && this.#ready && !payload.isStale(),
        );
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
            if (!this.#closing && epoch === this.#epoch)
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

  ownsPartition(partition: number): boolean {
    return this.#ready && this.#assigned.has(partition);
  }

  async ownerClientId(partition: number): Promise<string | undefined> {
    if (!this.#memberCache || this.#memberCache.until < Date.now()) {
      await this.#bounds();
      const description = await this.#admin.describeGroups([this.#options.groupId]);
      const owners = new Map<number, string>();
      for (const member of description.groups[0]?.members ?? [])
        for (const p of member.assignment.topicPartitions)
          if (p.topic === this.#options.topic) owners.set(p.partition, member.clientId);
      this.#memberCache = { owners, until: Date.now() + 1000 };
    }
    return this.#memberCache.owners.get(partition);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#epoch++;
    this.#wake?.();
    await this.#run;
    if (this.#adminReady) await this.#admin.disconnect();
  }
}
