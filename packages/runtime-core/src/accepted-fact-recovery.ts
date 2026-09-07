import type { Database } from "@pi-cloud/database";
import { sql, type Kysely, type Transaction } from "kysely";
import { kafkaProducerLane } from "./kafka-accepted-fact.ts";

export type KafkaPartitionBounds = Readonly<{ partition: number; low: bigint; high: bigint }>;
export type FactPosition = Readonly<{ topic: string; partition: number; offset: bigint }>;

/** Co-commit with semantic data. Deltas never create PG rows or offset writes. */
export async function recordFactProjection(
  db: Transaction<Database>,
  position: FactPosition,
): Promise<void> {
  await sql`insert into accepted_fact_projection_offsets(topic,partition,next_offset)
    values(${position.topic},${position.partition},${(position.offset + 1n).toString()}::bigint)
    on conflict(topic,partition) do update set next_offset=greatest(
      accepted_fact_projection_offsets.next_offset,excluded.next_offset)`.execute(db);
}

/** Caller captures Kafka bounds BEFORE this query, so a concurrent new Run or
 * first publication cannot disappear behind a later database checkpoint. */
export async function loadFactReplayOffsets(
  db: Kysely<Database>,
  topic: string,
  bounds: readonly KafkaPartitionBounds[],
  options: { partitionCount?: number; retentionMs?: number } = {},
): Promise<ReadonlyMap<number, bigint | Error>> {
  const rows = await sql<{
    partition: number;
    next_offset: string | null;
    first_offset: string | null;
  }>`
    select requested.partition, checkpoint.next_offset, pending.first_offset
    from unnest(${bounds.map((b) => b.partition)}::integer[]) requested(partition)
    left join accepted_fact_projection_offsets checkpoint
      on checkpoint.topic=${topic} and checkpoint.partition=requested.partition
    left join lateral (
      select min(output_first_offset) as first_offset from run_attempts
      where output_first_topic=${topic} and output_first_partition=requested.partition
        and output_sealed_at is null
    ) pending on true`.execute(db);
  const starts = new Map<number, bigint | Error>();
  for (const bound of bounds) {
    const row = rows.rows.find((r) => r.partition === bound.partition);
    const checkpoint = row?.next_offset == null ? bound.low : BigInt(row.next_offset);
    const pending = row?.first_offset == null ? bound.high : BigInt(row.first_offset);
    const start = [checkpoint < bound.low ? bound.low : checkpoint, pending, bound.high].reduce(
      (a, b) => (a < b ? a : b),
    );
    starts.set(
      bound.partition,
      pending < bound.low
        ? new Error("Unsealed execution recovery position expired from Kafka")
        : start,
    );
  }
  const unknown = await sql<{ session_id: string }>`select run.session_id from run_attempts attempt
    join runs run on run.id=attempt.run_id where attempt.output_sealed_at is null
      and attempt.output_first_offset is null and (attempt.running_at is not null or attempt.output_seal_id is not null)
      and attempt.claimed_at < now() - ${options.retentionMs ?? 7_200_000} * interval '1 millisecond'`.execute(
    db,
  );
  const count = options.partitionCount ?? Math.max(1, ...bounds.map((b) => b.partition + 1));
  for (const row of unknown.rows) {
    const partition = kafkaProducerLane(row.session_id, count);
    if (starts.has(partition))
      starts.set(partition, new Error("Unobserved execution exceeds Kafka retention"));
  }
  return starts;
}
