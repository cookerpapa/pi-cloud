import { KafkaPartitionReader } from "./kafka-partition-reader.ts";
import { KafkaPublicationWriter } from "./kafka-publication-writer.ts";
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
  /** Boot-local callback delivery only; never a durable projection recovery cursor. */
  resumeFromMemory?: boolean;
  /** Include completed delivery as well as the durable projection recovery floor. */
  groupRecovery?: boolean;
  /** Preserve a monotonic effect-dispatch boundary even when projection replay rewinds. */
  orderedEffects?: boolean;
  /** Owner discovery uses the composition's existing Admin metadata adapter. */
  readPartitionOwners?(): Promise<ReadonlyMap<number, string>>;
  onReset?(): void;
  onRevoked?(): void;
  onAssigned?(partitions: readonly number[], current: () => boolean): Promise<void>;
  replayOffsets?(
    bounds: readonly KafkaPartitionBounds[],
    partitionCount: number,
  ): Promise<ReadonlyMap<number, bigint | Error>>;
  handler(
    record: KafkaLogRecord<T>,
    current?: () => boolean,
    commitBeforeEffect?: () => Promise<boolean>,
  ): Promise<void>;
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
  readonly #committedOffsets = new Map<number, bigint>();
  readonly #lastCommitAt = new Map<number, number>();
  readonly #initialTargets = new Map<number, bigint>();
  readonly #retries = new Map<number, { since: number; count: number; timer: NodeJS.Timeout }>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #assigned = new Set<number>();
  readonly #blocked = new Map<number, Error>();
  #memberCache: { until: number; owners: Map<number, string> } | undefined;
  #membersLoading: Promise<ReadonlyMap<number, string>> | undefined;
  #reader: KafkaPartitionReader | undefined;
  readonly #publicationWriters = new Set<KafkaPublicationWriter>();

  constructor(options: KafkaLogConsumerOptions<T>) {
    if (options.orderedEffects && !options.groupRecovery)
      throw new Error("Ordered effects require durable group progress");
    if (
      options.resumeFromMemory &&
      (options.commitMessages !== false ||
        options.groupRecovery ||
        options.orderedEffects ||
        options.replayOffsets)
    )
      throw new Error(
        "Memory resume requires an uncommitted callback consumer without durable replay",
      );
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
        offsets = await this.#admin.fetchTopicOffsets(this.#options.topic, { isolationLevel: 1 });
        // librdkafka can return -1 sentinels while a newly created Topic is
        // propagating. They are not offsets: assigning -1 would mean END and
        // could silently skip accepted records.
        if (
          !offsets.length ||
          offsets.some((p) => {
            const low = BigInt(p.low ?? -1),
              high = BigInt(p.high ?? p.offset);
            return low < 0n || high < low;
          })
        )
          throw Object.assign(new Error("Kafka Topic bounds are not available yet"), {
            code: CODES.ERRORS.ERR_LEADER_NOT_AVAILABLE,
          });
        break;
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (
          this.#closing ||
          Date.now() >= deadline ||
          (code !== CODES.ERRORS.ERR_UNKNOWN_TOPIC_OR_PART &&
            code !== CODES.ERRORS.ERR_LEADER_NOT_AVAILABLE &&
            code !== CODES.ERRORS.ERR__NOENT)
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
      let retired = false;
      // The bounded reader reports background failure through this port. Never
      // leave an apparently connected consumer serving after its poller exits.
      const logger: KafkaTypes.Logger = {
        info() {},
        warn() {},
        debug() {},
        setLogLevel() {},
        namespace() {
          return this;
        },
        error: (message) => {
          if (retired || this.#closing) return;
          retired = true;
          this.#ready = false;
          this.#failure = new Error(String(message));
          operationalLog({
            service: "pi-cloud-kafka-consumer",
            level: "error",
            event: "consumer.failed",
            attributes: {
              reason: ["KafkaPausedPartitionDeliveryError", "LibrdKafkaError", "Error"].includes(
                String(message),
              )
                ? String(message)
                : "KafkaReaderError",
            },
          });
          restart();
        },
      };
      const consumer = new KafkaPartitionReader({
        brokers: this.#options.brokers,
        clientId: this.#options.clientId,
        groupId: this.#options.groupId,
        topic: this.#options.topic,
        logger,
        onPosition: (partition, offset) => {
          if (
            retired ||
            this.#closing ||
            !this.#ready ||
            !this.#assigned.has(partition) ||
            this.#blocked.has(partition) ||
            this.#retries.has(partition)
          )
            return;
          if (offset > (this.#processedOffsets.get(partition) ?? -1n))
            this.#processedOffsets.set(partition, offset);
        },
        rebalance: async (
          error: { code: number },
          assignments: Array<{ topic: string; partition: number; offset?: number }>,
          functions: {
            assign(value: Array<{ topic: string; partition: number; offset?: number }>): void;
            unassign(value: Array<{ topic: string; partition: number; offset?: number }>): void;
          },
        ) => {
          if (retired || this.#closing) {
            functions.unassign(assignments);
            return;
          }
          const assignmentEpoch = ++this.#epoch;
          this.#memberCache = undefined;
          this.#options.onRevoked?.();
          const publicationRetirement = this.#retirePublicationWriters();
          this.#ready = false;
          this.#assigned.clear();
          this.#blocked.clear();
          for (const retry of this.#retries.values()) clearTimeout(retry.timer);
          this.#retries.clear();
          if (error.code !== CODES.ERRORS.ERR__ASSIGN_PARTITIONS) {
            this.#options.onReset?.();
            functions.unassign(assignments);
            await publicationRetirement;
            return;
          }
          try {
            const currentAssignment = () =>
              !retired && !this.#closing && assignmentEpoch === this.#epoch;
            await publicationRetirement;
            await Promise.allSettled([...this.#inflight]);
            if (!currentAssignment()) return;
            this.#options.onReset?.();
            await this.#options.onAssigned?.(
              assignments.map((a) => a.partition),
              currentAssignment,
            );
            if (!currentAssignment()) return;
            const allBounds = await this.#bounds();
            if (!currentAssignment()) return;
            const bounds = allBounds.filter((b) =>
              assignments.some((a) => a.partition === b.partition),
            );
            const committed = this.#options.groupRecovery
              ? await this.#admin.fetchOffsets({
                  groupId: this.#options.groupId,
                  topics: [this.#options.topic],
                  requireStableOffsets: true,
                })
              : [];
            if (!currentAssignment()) return;
            const groupOffsets = new Map(
              committed.flatMap((t) =>
                t.partitions.map((p) => [p.partition, BigInt(p.offset)] as const),
              ),
            );
            for (const bound of bounds)
              this.#committedOffsets.set(bound.partition, groupOffsets.get(bound.partition) ?? -1n);
            consumer.seedCommitted(
              new Map(
                bounds.map((b) => [
                  b.partition,
                  (groupOffsets.get(b.partition) ?? -1n) < b.low
                    ? b.low
                    : groupOffsets.get(b.partition)!,
                ]),
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
              : this.#options.resumeFromMemory
                ? new Map(
                    bounds.map((b) => {
                      const saved = this.#processedOffsets.get(b.partition) ?? b.low;
                      return [
                        b.partition,
                        saved > b.high
                          ? new Error("Kafka local delivery position is outside retention")
                          : saved < b.low
                            ? b.low
                            : saved,
                      ] as const;
                    }),
                  )
                : this.#options.replayOffsets
                  ? new Map(await this.#options.replayOffsets(bounds, allBounds.length))
                  : new Map(bounds.map((b) => [b.partition, b.low]));
            if (this.#options.groupRecovery && this.#options.replayOffsets) {
              const recovery = await this.#options.replayOffsets(bounds, allBounds.length);
              if (!currentAssignment()) return;
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
              // An impossible volatile cursor must survive reassignment. Erasing
              // it here would silently accept a reset/truncated Topic next time.
              if (!(offset instanceof Error) || !this.#options.resumeFromMemory)
                this.#processedOffsets.set(b.partition, offset instanceof Error ? b.low : offset);
              this.#initialTargets.set(b.partition, b.high);
            }
            if (!currentAssignment()) return;
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
            if (retired || this.#closing || assignmentEpoch !== this.#epoch) return;
            // The native callback otherwise falls back to default assignment.
            // Never consume from an unverified recovery position after an error.
            functions.assign([]);
            this.#failure = failure;
            restart();
          }
        },
      });
      const progressing = new Map<number, Promise<void>>();
      const progressTimer = setInterval(() => {
        if (!this.#ready || retired || this.#closing || this.#options.commitMessages === false)
          return;
        const epoch = this.#epoch;
        for (const partition of this.#assigned) {
          if (progressing.has(partition)) continue;
          const task = this.#commitProgress(consumer, partition, epoch)
            .catch(() => {
              if (epoch === this.#epoch && !retired && !this.#closing)
                logger.error("Kafka progress commit failed");
            })
            .finally(() => {
              if (progressing.get(partition) === task) progressing.delete(partition);
            });
          progressing.set(partition, task);
        }
      }, 1000);
      progressTimer.unref();
      this.#reader = consumer;
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
        clearInterval(progressTimer);
        retired = true;
        this.#ready = false;
        this.#epoch++;
        this.#memberCache = undefined;
        this.#options.onRevoked?.();
        this.#options.onReset?.();
        for (const retry of this.#retries.values()) clearTimeout(retry.timer);
        this.#retries.clear();
        // Retire partition producers, including initialization. The reader
        // also joins group transactions borrowed by external Session seal
        // writers before disconnecting its native consumer.
        await this.#retirePublicationWriters();
        await consumer.disconnect().catch(() => undefined);
        await Promise.allSettled(progressing.values());
        if (this.#reader === consumer) this.#reader = undefined;
      }
      if (!this.#closing) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async #commitProgress(
    consumer: KafkaPartitionReader,
    partition: number,
    epoch: number,
  ): Promise<void> {
    const offset = this.#processedOffsets.get(partition);
    if (offset === undefined || offset <= (this.#committedOffsets.get(partition) ?? -1n)) return;
    await consumer.commitOffset({
      topic: this.#options.topic,
      partition,
      offset: offset.toString(),
    });
    if (epoch !== this.#epoch || this.#closing) return;
    if (offset > (this.#committedOffsets.get(partition) ?? -1n))
      this.#committedOffsets.set(partition, offset);
    this.#lastCommitAt.set(partition, performance.now());
  }

  async #batch(
    consumer: KafkaPartitionReader,
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
          this.#options.orderedEffects
            ? async () => {
                if (epoch !== this.#epoch || payload.isStale() || this.#closing) return false;
                const next = BigInt(message.offset) + 1n;
                if (next <= (this.#committedOffsets.get(batch.partition) ?? -1n)) return false;
                await consumer.commitOffset({
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: next.toString(),
                });
                if (epoch !== this.#epoch || payload.isStale() || this.#closing) return false;
                this.#committedOffsets.set(batch.partition, next);
                this.#lastCommitAt.set(batch.partition, performance.now());
                return true;
              }
            : undefined,
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
    if (
      (this.#options.orderedEffects || this.#options.commitMessages !== false) &&
      epoch === this.#epoch &&
      !payload.isStale() &&
      !this.#closing
    ) {
      const next = this.#processedOffsets.get(batch.partition);
      if (
        next !== undefined &&
        next > (this.#committedOffsets.get(batch.partition) ?? -1n) &&
        performance.now() - (this.#lastCommitAt.get(batch.partition) ?? -Infinity) >= 1000
      ) {
        await consumer.commitOffset({
          topic: batch.topic,
          partition: batch.partition,
          offset: next.toString(),
        });
        if (epoch === this.#epoch && !payload.isStale()) {
          if (next > (this.#committedOffsets.get(batch.partition) ?? -1n))
            this.#committedOffsets.set(batch.partition, next);
          this.#lastCommitAt.set(batch.partition, performance.now());
        }
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
      if (this.#ready && this.#blocked.size === 0 && this.#assigned.size > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Kafka consumer group assignment is unavailable", { cause: this.#failure });
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

  ownsPartition(partition: number): boolean {
    return this.#ready && this.#assigned.has(partition);
  }

  async openPublicationWriter(
    partition: number,
    current: () => boolean,
  ): Promise<KafkaPublicationWriter> {
    const reader = this.#reader;
    if (!reader || !current()) throw new Error("Publication consumer assignment is unavailable");
    const writer = new KafkaPublicationWriter({
      brokers: this.#options.brokers,
      clientId: this.#options.clientId,
      topic: this.#options.topic,
      partition,
      reader,
      current: () => current() && this.#reader === reader,
    });
    this.#publicationWriters.add(writer);
    try {
      await writer.start();
      return writer;
    } catch (error) {
      await writer.close();
      this.#publicationWriters.delete(writer);
      throw error;
    }
  }

  /** Session closure uses the Worker's stable producer ID but must still be
   * committed by the current Projector group member. */
  publicationTransaction(partition: number, current: () => boolean) {
    const reader = this.#reader;
    if (!reader || !current()) throw new Error("Publication consumer assignment is unavailable");
    return async (
      producer: import("@confluentinc/kafka-javascript").Producer,
      send: () => Promise<void>,
    ) => {
      if (this.#reader !== reader || !current()) throw new Error("Publication owner changed");
      await reader.commitPublication(partition, producer, send);
    };
  }

  async #retirePublicationWriters(): Promise<void> {
    const writers = [...this.#publicationWriters];
    await Promise.allSettled(writers.map((writer) => writer.close()));
    for (const writer of writers) this.#publicationWriters.delete(writer);
  }

  async partitionOwners(): Promise<ReadonlyMap<number, string>> {
    if (this.#closing) throw new Error("Session Projector is closing");
    if (this.#memberCache && this.#memberCache.until >= Date.now()) return this.#memberCache.owners;
    if (!this.#membersLoading) {
      const epoch = this.#epoch;
      const loading = (async () => {
        if (!this.#options.readPartitionOwners)
          throw new Error("Kafka group metadata reader is unavailable");
        const owners = new Map(await this.#options.readPartitionOwners());
        if (epoch !== this.#epoch || this.#closing) throw new Error("Projector ownership changed");
        this.#memberCache = { owners, until: Date.now() + 1000 };
        return owners;
      })().finally(() => {
        if (this.#membersLoading === loading) this.#membersLoading = undefined;
      });
      this.#membersLoading = loading;
    }
    return this.#membersLoading;
  }
  async ownerClientId(partition: number): Promise<string | undefined> {
    return (await this.partitionOwners()).get(partition);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#epoch++;
    this.#wake?.();
    await this.#run;
    if (this.#adminReady) await this.#admin.disconnect();
  }
}
