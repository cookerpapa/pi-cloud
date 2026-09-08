import { Admin } from "@platformatic/kafka";
import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";

export async function acceptedFactRetentionFloors(
  database: Kysely<Database>,
  topic: string,
  partitions: readonly number[],
) {
  // One PG snapshot: never combine a new checkpoint with an older pending set.
  const result = await sql<{ partition: number; floor: string | null }>`select requested.partition,
    case when checkpoint.next_offset is null then null
      else least(checkpoint.next_offset,pending.first_offset) end as floor
    from unnest(${[...partitions]}::integer[]) requested(partition)
    left join accepted_fact_projection_offsets checkpoint
      on checkpoint.topic=${topic} and checkpoint.partition=requested.partition
    left join lateral (select min(output_first_offset) first_offset from run_attempts
      where output_first_topic=${topic} and output_first_partition=requested.partition
        and output_sealed_at is null) pending on true`.execute(database);
  return new Map(result.rows.map((r) => [r.partition, r.floor === null ? null : BigInt(r.floor)]));
}

/** Kafka performs physical deletion; cloud only supplies a safe low-water mark.
 * A stopped projector/PG outage retains accepted data, even beyond the grace. */
export class KafkaSafeRetention {
  readonly #admin: Pick<Admin, "listOffsets" | "deleteRecords" | "close">;
  readonly #database: Kysely<Database>;
  readonly #topic: string;
  readonly #graceMs: number;
  #partitions: number[] = [];
  #timer: NodeJS.Timeout | undefined;
  #sweep: Promise<void> | undefined;
  #error: unknown;
  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
    graceMs: number;
    admin?: Pick<Admin, "listOffsets" | "deleteRecords" | "close">;
  }) {
    this.#database = options.database;
    this.#topic = options.topic;
    this.#graceMs = options.graceMs;
    this.#admin =
      options.admin ??
      new Admin({
        bootstrapBrokers: [...options.brokers],
        clientId: `${options.clientId}-safe-retention`,
        autocreateTopics: false,
      });
  }
  start(partitions: number) {
    this.#partitions = Array.from({ length: partitions }, (_, i) => i);
    this.#timer = setInterval(() => {
      if (this.#sweep) return;
      this.#sweep = this.sweep()
        .then(
          () => {
            this.#error = undefined;
          },
          (error: unknown) => {
            this.#error = error;
          },
        )
        .finally(() => {
          this.#sweep = undefined;
        });
    }, 60_000);
    this.#timer.unref();
  }
  async sweep(now = Date.now()) {
    const offsets = (timestamp: bigint) =>
      this.#admin.listOffsets({
        topics: [
          {
            name: this.#topic,
            partitions: this.#partitions.map((partitionIndex) => ({ partitionIndex, timestamp })),
          },
        ],
      });
    // Capture Kafka bounds before PG. New appends are outside this deletion cut.
    const [ends, ages] = await Promise.all([offsets(-1n), offsets(BigInt(now - this.#graceMs))]);
    const high = new Map(
      ends.flatMap((t) => t.partitions.map((p) => [p.partitionIndex, p.offset] as const)),
    );
    const aged = new Map(
      ages.flatMap((t) => t.partitions.map((p) => [p.partitionIndex, p.offset] as const)),
    );
    const floors = await acceptedFactRetentionFloors(this.#database, this.#topic, this.#partitions);
    const targets = this.#partitions.flatMap((partition) => {
      const floor = floors.get(partition),
        end = high.get(partition),
        time = aged.get(partition);
      if (floor == null || end === undefined || time === undefined) return [];
      const limit = time < 0n ? end : time;
      const offset = [floor, end, limit].reduce((a, b) => (a < b ? a : b));
      return offset > 0n ? [{ partition, offset }] : [];
    });
    if (targets.length)
      await this.#admin.deleteRecords({ topics: [{ name: this.#topic, partitions: targets }] });
  }
  checkHealth() {
    if (this.#error) throw this.#error;
  }
  async close() {
    if (this.#timer) clearInterval(this.#timer);
    await this.#sweep;
    await this.#admin.close();
  }
}
