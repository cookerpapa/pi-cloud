import { Admin, ProtocolError } from "@platformatic/kafka";
import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  TOOL_REPLY_RETENTION_MS,
  TOOL_REPLY_TOPIC_PREFIX,
  TOOL_REPLY_TOPIC_PATTERN,
  toolReplyTopic,
} from "@pi-cloud/event-log";

function alreadyDeleted(error: unknown, code: number): boolean {
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every((item) => alreadyDeleted(item, code));
  return error instanceof ProtocolError && error.apiCode === code;
}

async function deleteIfPresent(action: () => Promise<void>, missingCode: number): Promise<void> {
  try {
    await action();
  } catch (error) {
    // Another Projector can finish the same retired-boot cleanup concurrently.
    if (!alreadyDeleted(error, missingCode)) throw error;
  }
}

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
    left join lateral (select min(first_offset) first_offset from (
      select min(output_first_offset) first_offset from runs
        where output_first_topic=${topic} and output_first_partition=requested.partition
          and output_sealed_at is null
      union all
      select min(replay_offset) from pi_durable_current
        where replay_topic=${topic} and replay_partition=requested.partition and replay_offset is not null
    ) required) pending on true`.execute(database);
  return new Map(result.rows.map((r) => [r.partition, r.floor === null ? null : BigInt(r.floor)]));
}

/** Kafka performs physical deletion; cloud only supplies a safe low-water mark.
 * A stopped projector/PG outage retains accepted data, even beyond the grace. */
export class KafkaSafeRetention {
  readonly #admin: Pick<
    Admin,
    | "listOffsets"
    | "deleteRecords"
    | "listTopics"
    | "deleteTopics"
    | "listGroups"
    | "deleteGroups"
    | "close"
  >;
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
    admin?: Pick<
      Admin,
      | "listOffsets"
      | "deleteRecords"
      | "listTopics"
      | "deleteTopics"
      | "listGroups"
      | "deleteGroups"
      | "close"
    >;
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
    // Only positively retired Worker boots are eligible; neither a missed
    // heartbeat nor the absence of a consumer is evidence that a mailbox is dead.
    const replyTopics = (await this.#admin.listTopics()).filter((name) =>
      TOOL_REPLY_TOPIC_PATTERN.test(name),
    );
    const replyOffsets = (timestamp: bigint) =>
      replyTopics.length
        ? this.#admin.listOffsets({
            topics: replyTopics.map((name) => ({
              name,
              partitions: [{ partitionIndex: 0, timestamp }],
            })),
          })
        : Promise.resolve([]);
    // Capture both cuts before the PG snapshot, exactly as for the Session log.
    const [replyEnds, replyAges] = await Promise.all([
      replyOffsets(-1n),
      replyOffsets(BigInt(now - TOOL_REPLY_RETENTION_MS)),
    ]);
    const replyHigh = new Map(replyEnds.map((t) => [t.name, t.partitions[0]?.offset]));
    const pendingReplies = replyTopics.length
      ? await sql<{ topic: string; floor: string }>`
      select fields->>'replyTopic' as topic,min((fields->>'replyOffset')::bigint)::text as floor
      from pi_durable_owned_records
      where kind='task' and fields ? 'replyTopic' and fields->>'status'<>'terminal'
        and fields->>'replyTopic'=any(${replyTopics}::text[])
      group by fields->>'replyTopic'`.execute(this.#database)
      : { rows: [] };
    const replyFloors = new Map(pendingReplies.rows.map((r) => [r.topic, BigInt(r.floor)]));
    // Result age alone is not enough: a callback can have reached Kafka before
    // the current Worker commits Pi's canonical result.
    if (replyTopics.length) {
      for (const topic of replyAges) {
        const position = topic.partitions.find((p) => p.partitionIndex === 0)?.offset;
        const end = replyHigh.get(topic.name);
        if (position === undefined || end === undefined) continue;
        const limit = position < 0n || position > end ? end : position;
        const floor = replyFloors.get(topic.name);
        const before = floor === undefined || limit < floor ? limit : floor;
        if (before > 0n)
          await this.#admin.deleteRecords({
            topics: [{ name: topic.name, partitions: [{ partition: 0, offset: before }] }],
          });
      }
    }
    const groups = await this.#admin.listGroups();
    const retiredCandidates = new Set(
      replyTopics.map((name) => name.slice(TOOL_REPLY_TOPIC_PREFIX.length)),
    );
    const restoredGroups = new Map<string, string[]>();
    for (const id of groups.keys()) {
      const restored = /^tool-restore-([0-9a-f-]{36})-[0-9a-f]{16}-[0-9a-f-]{36}$/.exec(id);
      if (restored && TOOL_REPLY_TOPIC_PATTERN.test(`${TOOL_REPLY_TOPIC_PREFIX}${restored[1]}`)) {
        const boot = restored[1]!;
        retiredCandidates.add(boot);
        restoredGroups.set(boot, [...(restoredGroups.get(boot) ?? []), id]);
      }
      if (
        id.startsWith("tool-reply-") &&
        TOOL_REPLY_TOPIC_PATTERN.test(`${TOOL_REPLY_TOPIC_PREFIX}${id.slice(11)}`)
      )
        retiredCandidates.add(id.slice(11));
    }
    if (retiredCandidates.size) {
      const retired = await this.#database
        .selectFrom("worker_retirements")
        .select("boot_id")
        .where("boot_id", "in", [...retiredCandidates])
        .where("state", "=", "completed")
        .where("completed_at", "<", new Date(now - TOOL_REPLY_RETENTION_MS))
        .limit(64)
        .execute();
      for (const row of retired) {
        for (const restored of restoredGroups.get(row.boot_id) ?? [])
          await deleteIfPresent(() => this.#admin.deleteGroups({ groups: [restored] }), 69);
        const topic = toolReplyTopic(row.boot_id),
          group = `tool-reply-${row.boot_id}`;
        if (replyFloors.has(topic)) continue;
        if (replyTopics.includes(topic))
          await deleteIfPresent(() => this.#admin.deleteTopics({ topics: [topic] }), 3);
        if (groups.has(group))
          await deleteIfPresent(() => this.#admin.deleteGroups({ groups: [group] }), 69);
      }
    }
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
