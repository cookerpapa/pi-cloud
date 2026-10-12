import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction, type RawBuilder } from "kysely";
import type { Database } from "@pi-cloud/database";
import { validateImageReferencePayload, type DurableRecordOrigin } from "@pi-cloud/protocol";
import {
  decodeSessionImages,
  retainSessionImages,
  type ImageAttachmentCodec,
} from "@pi-cloud/session-attachments";
import type {
  Seq,
  DocumentRecord,
  StorageWrite,
  StoredDocument,
  JsonObject,
} from "@earendil-works/pi-durable";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import {
  prepareCurrentStates,
  currentStateIds,
  currentStateIndex,
  currentStateFingerprint,
  historyFingerprint,
  isLiveRow,
  isPendingLiveRow,
  type CurrentStateRow,
  type CurrentStateSource,
  type HistoryWriteRow,
} from "./current-state.ts";
import {
  NativeLiveState,
  type NativeLiveProjection,
  type NativeReplayPosition,
} from "./live-state.ts";
import {
  indexNative,
  type DurableBatch,
  type StoredDurableBatch,
  type DurableScope,
  type IndexedRecord,
  type NativeRecord,
  type RecordQuery,
  type DocumentRevision,
} from "./types.ts";

type RecordRow = {
  kind: IndexedRecord["kind"];
  seq: string;
  ordinal: number;
  body: string | null;
  fields: Record<string, string>;
  created_seq: string | null;
  retired_seq: string | null;
};
const INDEX_FIELDS = new Set([
  "conversation",
  "nativeKind",
  "task",
  "role",
  "head",
  "navigation",
  "currentOnly",
  "status",
  "entry",
  "request",
  "background",
  "abortRequested",
  "outcome",
  "ownerConversation",
  "ownerTask",
  "scope",
  "address",
  "cloudSession",
  "run",
  "turn",
]);
const CURRENT_SOURCE_COLUMNS = sql`c.id::text,c.kind,c.seq::text,c.ordinal,c.body,c.delta_count,
  c.created_seq::text,c.retired_seq::text,c.cloud_origin,c.replay_topic,c.replay_partition,
  c.replay_offset::text,c.replay_seq::text,r.id as indexed_id,r.kind as indexed_kind,r.fields as indexed_fields`;
const decodeRecord = (row: RecordRow): IndexedRecord => {
  if (row.body === null) throw new Error("Native record body is missing");
  const write = JSON.parse(row.body) as StorageWrite;
  const value =
    write.type === "document.create"
      ? ({
          ...write.record,
          createdAt: Number(row.created_seq),
          ...(row.retired_seq === null ? {} : { retiredAt: Number(row.retired_seq) }),
        } as DocumentRecord)
      : "value" in write
        ? write.value
        : undefined;
  if (!value) throw new Error("Native record pointer does not address a record");
  return {
    kind: row.kind,
    seq: Number(row.seq),
    ordinal: row.ordinal,
    value,
    fields: row.fields,
    ...(row.created_seq === null ? {} : { createdSeq: Number(row.created_seq) }),
    ...(row.retired_seq === null ? {} : { retiredSeq: Number(row.retired_seq) }),
  };
};

/** Derived indexes resolve retained history or authoritative current state. This class never
 * allocates IDs/sequences and never makes an execution or replay decision. */
export class DurablePostgresProjection {
  readonly liveState = new NativeLiveState();
  constructor(
    readonly database: Kysely<Database>,
    readonly scope: DurableScope,
    readonly images?: ImageAttachmentCodec,
    readonly imageRepresentation: "decoded" | "references" = "decoded",
  ) {}
  scoped(alias: string): RawBuilder<boolean> {
    return sql<boolean>`${sql.ref(`${alias}.tenant_id`)}=${this.scope.tenantId}::uuid
      and ${sql.ref(`${alias}.session_id`)}=${this.scope.sessionId}`;
  }
  async assertComplete(): Promise<void> {
    const pending = await sql`select 1 from pi_durable_current c where ${this.scoped("c")}
      and c.replay_offset is not null limit 1`.execute(this.database);
    if (pending.rows.length)
      throw new Error("Native live state requires ordered Kafka recovery before cold open");
  }
  async head(requireComplete = false): Promise<{ seq: number; nextId: number }> {
    const result = await sql<{
      seq: string | null;
      next_id: string | null;
      incomplete: boolean;
    }>`select h.seq,h.next_id,${
      requireComplete
        ? sql`exists(select 1 from pi_durable_current live
      where ${this.scoped("live")} and live.replay_offset is not null)`
        : sql`false`
    } as incomplete
      from (select 1) seed left join lateral (
        select seq,next_id from pi_durable_commits c
        where ${this.scoped("c")} order by seq desc limit 1
      ) h on true`.execute(this.database);
    const row = result.rows[0]!;
    if (row.incomplete)
      throw new Error("Native live state requires ordered Kafka recovery before cold open");
    return { seq: Number(row.seq ?? 0), nextId: Number(row.next_id ?? 2) };
  }
  async get(id: number): Promise<IndexedRecord | undefined> {
    const result =
      await sql<RecordRow>`select r.kind,r.seq,r.ordinal,r.fields,r.created_seq,r.retired_seq,l.body
      from pi_durable_records r left join pi_durable_record_bodies l using(tenant_id,session_id,seq,ordinal)
      where ${this.scoped("r")} and r.id=${id}`.execute(this.database);
    return (
      result.rows[0] &&
      (this.imageRepresentation === "references"
        ? decodeRecord(result.rows[0])
        : decodeSessionImages<IndexedRecord>(this.images, this.scope, decodeRecord(result.rows[0])))
    );
  }
  async scan(
    query: RecordQuery,
    limit: number,
    exclude: readonly number[] = [],
  ): Promise<IndexedRecord[]> {
    const clauses: RawBuilder<unknown>[] = [this.scoped("r"), sql`r.kind=${query.kind}`];
    for (const [key, value] of Object.entries(query.fields ?? {})) {
      if (!INDEX_FIELDS.has(key)) throw new Error("Unsupported native index field");
      // Only code-owned keys are literal. User-supplied values remain bound;
      // a generic prepared plan can now match the fixed expression indexes.
      clauses.push(sql`r.fields->>${sql.lit(key)}=${value}`);
    }
    if (query.minId !== undefined) clauses.push(sql`r.id>=${query.minId}`);
    if (query.maxId !== undefined) clauses.push(sql`r.id<=${query.maxId}`);
    if (query.head) clauses.push(sql`r.fields ? 'head'`);
    if (exclude.length) clauses.push(sql`not (r.id=any(${[...exclude]}::bigint[]))`);
    if (query.at !== undefined)
      clauses.push(
        query.at === "current"
          ? sql`r.retired_seq is null`
          : sql`r.created_seq<=${query.at} and (r.retired_seq is null or r.retired_seq>${query.at})`,
      );
    const result =
      await sql<RecordRow>`select r.kind,r.seq,r.ordinal,r.fields,r.created_seq,r.retired_seq,l.body
      from pi_durable_records r left join pi_durable_record_bodies l using(tenant_id,session_id,seq,ordinal)
      where ${sql.join(clauses, sql` and `)} order by r.id ${query.descending ? sql`desc` : sql`asc`} limit ${limit}`.execute(
        this.database,
      );
    if (this.imageRepresentation === "references") return result.rows.map(decodeRecord);
    return decodeSessionImages<IndexedRecord[]>(
      this.images,
      this.scope,
      result.rows.map(decodeRecord),
    );
  }
  async revisions(id: number, through: number): Promise<DocumentRevision[]> {
    if (this.imageRepresentation === "references") return this.#storedRevisions(id, through);
    return decodeSessionImages<DocumentRevision[]>(
      this.images,
      this.scope,
      await this.#storedRevisions(id, through),
    );
  }
  async #storedRevisions(id: number, through: number): Promise<DocumentRevision[]> {
    type RevisionRow = {
      seq: string;
      ordinal: number;
      body: string | null;
      delta_count: number;
      checkpoint: string | null;
      current_state: boolean;
      replay_seq: string | null;
      current_row: CurrentStateRow | null;
      expected: string | null;
    };
    const result = await sql<RevisionRow>`with base as (
      select seq from pi_durable_document_revisions d where ${this.scoped("d")}
        and document_id=${id} and seq<=${through} and (kind='base' or checkpoint is not null)
      order by seq desc limit 1
    ) select d.seq,d.ordinal,d.delta_count,d.checkpoint,l.body,false as current_state,null::bigint as replay_seq,
        null::json as current_row,null::text as expected from pi_durable_document_revisions d
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where ${this.scoped("d")} and d.document_id=${id} and d.seq>=(select seq from base) and d.seq<=${through}
      union all select c.seq,c.ordinal,c.delta_count,null::text as checkpoint,null::text,true,c.replay_seq,
        row_to_json(c),h.current_hashes->>c.id::text
        from pi_durable_current c join pi_durable_commits h using(tenant_id,session_id,seq)
        where ${this.scoped("c")} and c.id=${id}
          and c.kind='document' and c.retired_seq is null and c.seq<=${through}
      order by seq`.execute(this.database);
    return result.rows.map((row) => {
      if (row.replay_seq !== null)
        throw new Error("Native live state requires Kafka replay; PG checkpoint is incomplete");
      if (
        row.current_state &&
        (!row.current_row || currentStateFingerprint(row.current_row) !== row.expected)
      )
        throw new Error("Native current checkpoint integrity check failed");
      const write = JSON.parse(row.current_row?.body ?? row.body!) as StorageWrite;
      if (write.type !== "document.create" && write.type !== "document.change")
        throw new Error("Invalid native document pointer");
      if (row.current_state && write.content.kind !== "base")
        throw new Error("Native current document needs a materialized base");
      return {
        id,
        seq: Number(row.seq),
        ordinal: row.ordinal,
        content: write.content,
        deltaCount: row.delta_count,
        // A projected complete value must win over the same-sequence delta
        // still held in the Worker's acknowledged overlay.
        ...(row.current_state && write.content.kind === "base"
          ? { checkpoint: write.content.value }
          : row.checkpoint === null
            ? {}
            : { checkpoint: JSON.parse(row.checkpoint) as JsonObject }),
      };
    });
  }
  async latestRevision(id: number): Promise<{ version: number; deltaCount: number } | undefined> {
    const result = await sql<{
      version: number;
      delta_count: number;
      body: string | null;
      replay_seq: string | null;
    }>`select version,delta_count,null::text as body,seq,null::bigint as replay_seq from pi_durable_document_revisions d
      where ${this.scoped("d")} and document_id=${id}
      union all select null::integer,delta_count,body,seq,replay_seq from pi_durable_current c
      where ${this.scoped("c")} and id=${id} and kind='document' and retired_seq is null
      order by seq desc limit 1`.execute(this.database);
    if (result.rows[0]?.replay_seq != null)
      throw new Error("Native live revision requires Kafka replay");
    return (
      result.rows[0] && {
        version:
          result.rows[0].body === null
            ? result.rows[0].version
            : JSON.parse(result.rows[0].body).content.version,
        deltaCount: result.rows[0].delta_count,
      }
    );
  }
  async apply(
    batch: DurableBatch | StoredDurableBatch,
    origins: readonly DurableRecordOrigin[] = [],
    position?: NativeReplayPosition,
  ): Promise<boolean> {
    const live = position ? { state: this.liveState.fork(), position } : undefined;
    const applied = await this.database
      .transaction()
      .execute((tx) => this.applyIn(tx, batch, origins, live));
    if (live) this.liveState.adopt(live.state);
    return applied;
  }
  async applyIn(
    tx: Transaction<Database>,
    stored: DurableBatch | StoredDurableBatch,
    origins: readonly DurableRecordOrigin[] = [],
    live?: NativeLiveProjection,
  ): Promise<boolean> {
    validateImageReferencePayload(stored);
    // Only non-image record metadata is interpreted here. Model/image parts
    // remain encoded in the canonical body and in derived document checkpoints.
    const batch = stored as DurableBatch;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ batch, origins }))
      .digest("hex");
    const ownership = new Map(origins.map((origin) => [origin.recordId, origin]));
    const parent =
      await sql`select id from pi_sessions p where p.tenant_id=${this.scope.tenantId}::uuid
      and p.id=${this.scope.sessionId} for update`.execute(tx);
    if (!parent.rows.length) throw new Error("Native Session was not found");
    const prior = await sql<{
      fingerprint: string;
      current_hashes: Record<string, string>;
    }>`select fingerprint,current_hashes from pi_durable_commits c
      where ${this.scoped("c")} and seq=${batch.seq}`.execute(tx);
    if (prior.rows[0]) {
      if (prior.rows[0].fingerprint !== fingerprint)
        throw new Error("Native commit position changed bytes");
      if (live) await this.#replayLiveIn(tx, batch, prior.rows[0].current_hashes, live);
      return false;
    }
    // Read the native watermark and touched current-state values together.
    // Unrelated document deltas do not acquire a separate metadata round trip.
    const pendingLive =
      live && live.state.through === undefined
        ? sql`coalesce((
      select json_agg(row) from (select ${CURRENT_SOURCE_COLUMNS}
        from pi_durable_current c left join pi_durable_records r using(tenant_id,session_id,id)
        where ${this.scoped("c")} and c.replay_offset is not null) row
    ),'[]'::json)`
        : sql`'[]'::json`;
    const {
      rows: [head],
    } = await sql<{
      seq: string;
      next_id: string;
      inputs: CurrentStateSource[];
      pending_live: CurrentStateSource[];
    }>`
      select coalesce(h.seq,0)::text as seq,coalesce(h.next_id,2)::text as next_id,
        coalesce(state.inputs,'[]'::json) as inputs,${pendingLive} as pending_live
      from (select 1) seed left join lateral (
        select seq,next_id from pi_durable_commits c where ${this.scoped("c")} order by seq desc limit 1
      ) h on true left join lateral (
        select json_agg(row) as inputs from (
          select ${CURRENT_SOURCE_COLUMNS}
          from pi_durable_records r left join pi_durable_current c using(tenant_id,session_id,id)
          where ${this.scoped("r")} and r.id=any(${currentStateIds(batch)}::bigint[])
        ) row
      ) state on true`.execute(tx);
    if (!head || batch.seq !== Number(head.seq) + 1 || batch.nextId < Number(head.next_id))
      throw new Error("Native commit sequence or ID watermark is not contiguous");
    if (live) {
      live.state.initialize(Number(head.seq), this.#validateLiveCheckpoints(head.pending_live));
      if (live.state.through !== Number(head.seq))
        throw new Error("Native live replay has not reached the projected head");
    }
    const parentIds = [
      ...new Set(
        batch.writes.flatMap((write) =>
          write.type === "entry" && write.value.byTaskId !== undefined
            ? [write.value.byTaskId]
            : write.type === "task" || write.type === "submission"
              ? [
                  write.value.id,
                  ...(!("owner" in write.value) || write.value.owner === undefined
                    ? []
                    : [write.value.owner]),
                ]
              : [],
        ),
      ),
    ];
    const priorOrigins = new Map<number, Record<string, string>>();
    if (parentIds.length) {
      const rows = await sql<{
        id: string;
        fields: Record<string, string>;
      }>`select id,fields from pi_durable_records r
        where ${this.scoped("r")} and id=any(${parentIds}::bigint[])`.execute(tx);
      for (const row of rows.rows) priorOrigins.set(Number(row.id), row.fields);
    }
    const records = new Map<number, NativeRecord>(
      batch.writes.flatMap((write) =>
        "value" in write ? [[write.value.id, write.value] as const] : [],
      ),
    );
    const effective = new Map<number, Record<string, string> | undefined>();
    const originFor = (
      id: number,
      visited = new Set<number>(),
    ): Record<string, string> | undefined => {
      if (effective.has(id)) return effective.get(id);
      if (visited.has(id)) return undefined;
      visited.add(id);
      const prior = priorOrigins.get(id);
      if (prior?.run) {
        effective.set(id, prior);
        return prior;
      }
      const value = records.get(id),
        source = ownership.get(id);
      const parent =
        value &&
        ("byTaskId" in value
          ? value.byTaskId
          : "owner" in value && typeof value.owner === "number"
            ? value.owner
            : undefined);
      const inherited = typeof parent === "number" ? originFor(parent, visited) : undefined;
      const fields =
        inherited ??
        (source
          ? { cloudSession: source.sessionId, run: source.runId, turn: source.turnId }
          : undefined);
      effective.set(id, fields);
      return fields;
    };
    for (const id of records.keys()) originFor(id);
    const current = prepareCurrentStates(
      batch,
      effective,
      this.#liveSources(head.inputs, live?.state),
    );
    const pending = current.rows.filter(isPendingLiveRow);
    if (pending.length && !live)
      throw new Error("Native live progress requires an ordered Kafka position");
    const checkpoints = current.rows.filter((row) => !isPendingLiveRow(row));
    const history: HistoryWriteRow[] = batch.writes.flatMap((write, ordinal) => {
      if (current.omitted.has(ordinal)) return [];
      const id = "value" in write ? write.value.id : "record" in write ? write.record.id : write.id;
      const fields = effective.get(id);
      return [
        {
          ordinal,
          record_kind: write.type,
          record_id: String(id),
          body: JSON.stringify(write),
          phase:
            write.type === "task" && "checkpoint" in write.value.state
              ? (JSON.stringify((write.value.state.checkpoint as { phase?: unknown }).phase) ??
                null)
              : null,
          cloud_origin: fields
            ? Object.fromEntries(
                ["cloudSession", "run", "turn"]
                  .filter((key) => fields[key] !== undefined)
                  .map((key) => [key, fields[key]!]),
              )
            : null,
        },
      ];
    });
    await retainSessionImages(tx, this.scope, stored);
    await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes)
      values(${this.scope.tenantId}::uuid,${this.scope.sessionId},${batch.seq},${batch.nextId},${fingerprint},${batch.writes.length},${history.length},${historyFingerprint(history)},${JSON.stringify(Object.fromEntries(current.rows.map((row) => [row.id, currentStateFingerprint(row)])))}::jsonb)`.execute(
      tx,
    );
    if (history.length)
      await sql`insert into pi_durable_log(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin) values
      ${sql.join(
        history.map(
          (row) =>
            sql`(${this.scope.tenantId}::uuid,${this.scope.sessionId},${batch.seq},${row.ordinal},${row.record_kind},${row.record_id},${row.body},${row.phase},${row.cloud_origin === null ? null : JSON.stringify(row.cloud_origin)}::jsonb)`,
        ),
      )}`.execute(tx);
    const retiredCurrent = current.rows
      .filter((r) => r.retired_seq !== null)
      .map((r) => Number(r.id));
    if (retiredCurrent.length)
      await sql`update pi_durable_records r set retired_seq=${batch.seq}
      where ${this.scoped("r")} and id=any(${retiredCurrent}::bigint[])`.execute(tx);
    await this.#indexBatch(tx, batch, effective, current.omitted);
    await this.#checkpointRows(tx, checkpoints);
    if (live) {
      for (const row of pending) {
        const before = head.inputs.find((r) => Number(r.id) === Number(row.id));
        if (!before?.body)
          throw new Error("Native live document requires a settled initial checkpoint");
        if (before.replay_seq !== null) {
          if (
            before.replay_topic !== live.position.topic ||
            before.replay_partition !== live.position.partition ||
            BigInt(before.replay_offset!) > live.position.offset
          )
            throw new Error("Native live replay reference changed Kafka stream");
        } else {
          const pinned =
            await sql`update pi_durable_current c set replay_topic=${live.position.topic},
            replay_partition=${live.position.partition},replay_offset=${live.position.offset.toString()}::bigint,replay_seq=${batch.seq}
            where ${this.scoped("c")} and id=${row.id}::bigint and replay_seq is null and seq<${batch.seq}
            returning id`.execute(tx);
          if (pinned.rows.length !== 1)
            throw new Error("Native live recovery reference was not installed");
        }
      }
      for (const row of current.rows)
        if (isLiveRow(row)) {
          if (isPendingLiveRow(row)) live.state.rows.set(Number(row.id), row);
          else live.state.rows.delete(Number(row.id));
        }
      live.state.through = batch.seq;
    }
    return true;
  }
  async #checkpointRows(
    tx: Transaction<Database>,
    rows: readonly CurrentStateRow[],
  ): Promise<void> {
    if (!rows.length) return;
    const result = await sql`insert into pi_durable_current as existing
      (tenant_id,session_id,id,kind,seq,ordinal,body,delta_count,created_seq,retired_seq,cloud_origin) values
      ${sql.join(rows.map((r) => sql`(${this.scope.tenantId}::uuid,${this.scope.sessionId},${r.id},${r.kind},${r.seq},${r.ordinal},${r.body},${r.delta_count},${r.created_seq},${r.retired_seq},${r.cloud_origin === null ? null : JSON.stringify(r.cloud_origin)}::jsonb)`))}
      on conflict(tenant_id,session_id,id) do update set seq=excluded.seq,ordinal=excluded.ordinal,
        body=excluded.body,delta_count=excluded.delta_count,retired_seq=excluded.retired_seq,cloud_origin=excluded.cloud_origin,
        replay_topic=null,replay_partition=null,replay_offset=null,replay_seq=null
      where existing.kind=excluded.kind and existing.seq<=excluded.seq
      returning id`.execute(tx);
    if (result.rows.length !== rows.length)
      throw new Error("Native current checkpoint changed identity or regressed");
    await this.#writeIndexes(tx, rows.map(currentStateIndex), true);
  }
  async #liveCheckpoints(tx: Transaction<Database>): Promise<CurrentStateSource[]> {
    const result =
      await sql<CurrentStateSource>`select c.*,r.id as indexed_id,r.kind as indexed_kind,r.fields as indexed_fields
      from pi_durable_current c left join pi_durable_records r using(tenant_id,session_id,id)
      where ${this.scoped("c")} and c.replay_offset is not null`.execute(tx);
    return this.#validateLiveCheckpoints(result.rows);
  }
  #validateLiveCheckpoints(rows: CurrentStateSource[]): CurrentStateSource[] {
    for (const row of rows) {
      if (!isLiveRow(row)) throw new Error("Replay reference does not address native live state");
      if (row.indexed_id == null) throw new Error("Native live checkpoint index is missing");
    }
    return rows;
  }
  async #initializeLive(
    tx: Transaction<Database>,
    state: NativeLiveState,
    head?: number,
  ): Promise<void> {
    if (state.through !== undefined) return;
    const current = head ?? (await new DurablePostgresProjection(tx, this.scope).head()).seq;
    state.initialize(current, await this.#liveCheckpoints(tx));
  }
  #liveSources(rows: readonly CurrentStateSource[], state?: NativeLiveState): CurrentStateSource[] {
    return rows.map((row) => {
      const cached = state?.rows.get(Number(row.id));
      if (!cached || Number(cached.seq) < Number(row.seq)) return row;
      return {
        ...row,
        ...cached,
        replay_topic: row.replay_topic,
        replay_partition: row.replay_partition,
        replay_offset: row.replay_offset,
        replay_seq: row.replay_seq,
      };
    });
  }
  async #replayLiveIn(
    tx: Transaction<Database>,
    batch: DurableBatch,
    hashes: Record<string, string>,
    live: NativeLiveProjection,
  ): Promise<void> {
    await this.#initializeLive(tx, live.state);
    if (batch.seq <= live.state.through!) return;
    if (batch.seq !== live.state.through! + 1)
      throw new Error("Native live Kafka recovery has a sequence gap");
    const { rows } =
      await sql<CurrentStateSource>`select c.*,r.id as indexed_id,r.kind as indexed_kind,r.fields as indexed_fields
      from pi_durable_current c join pi_durable_records r using(tenant_id,session_id,id)
      where ${this.scoped("c")} and c.id=any(${currentStateIds(batch)}::bigint[])`.execute(tx);
    const eligible = new Set<number>();
    for (const row of rows) {
      if (!isLiveRow(row)) continue;
      const cached = live.state.rows.get(Number(row.id));
      if (row.replay_seq === null) {
        if (cached && Number(cached.seq) <= Number(row.seq)) live.state.rows.delete(Number(row.id));
        continue;
      }
      if (
        batch.seq < Number(row.replay_seq) ||
        batch.seq <= Math.max(Number(row.seq), Number(cached?.seq ?? 0))
      )
        continue;
      if (
        row.replay_topic !== live.position.topic ||
        row.replay_partition !== live.position.partition ||
        live.position.offset < BigInt(row.replay_offset!)
      )
        throw new Error("Native live replay changed its protected Kafka range");
      eligible.add(Number(row.id));
    }
    const current = prepareCurrentStates(
      batch,
      new Map(),
      this.#liveSources(rows, live.state),
      (write) =>
        (write.type === "document.change" || write.type === "document.retire") &&
        eligible.has(write.id),
    );
    for (const row of current.rows) {
      if (currentStateFingerprint(row) !== hashes[row.id])
        throw new Error("Native live replay integrity check failed");
      if (isPendingLiveRow(row)) live.state.rows.set(Number(row.id), row);
      else live.state.rows.delete(Number(row.id));
    }
    live.state.through = batch.seq;
  }
  /** Read-only reconstruction of an already-accepted batch; never admits a new write. */
  async replayLiveIn(
    tx: Transaction<Database>,
    stored: StoredDurableBatch,
    origins: readonly DurableRecordOrigin[],
    live: NativeLiveProjection,
  ): Promise<boolean> {
    const header = await sql<{
      fingerprint: string;
      current_hashes: Record<string, string>;
    }>`select fingerprint,current_hashes
      from pi_durable_commits c where ${this.scoped("c")} and seq=${stored.seq}`.execute(tx);
    if (!header.rows[0]) return false;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ batch: stored, origins }))
      .digest("hex");
    if (header.rows[0].fingerprint !== fingerprint)
      throw new Error("Native replay position changed bytes");
    await this.#replayLiveIn(
      tx,
      stored as unknown as DurableBatch,
      header.rows[0].current_hashes,
      live,
    );
    return true;
  }
  /** Caller holds the existing closure authority locks. No native sequence is allocated. */
  async checkpointLiveIn(tx: Transaction<Database>, state: NativeLiveState): Promise<void> {
    await sql`select id from pi_sessions p where p.tenant_id=${this.scope.tenantId}::uuid and p.id=${this.scope.sessionId} for update`.execute(
      tx,
    );
    const head = await new DurablePostgresProjection(tx, this.scope).head();
    const pending = await this.#liveCheckpoints(tx);
    if (!pending.length) {
      state.rows.clear();
      state.through = head.seq;
      return;
    }
    if (state.through !== head.seq)
      throw new Error("Native live handoff must replay through the projected head");
    const expected = await sql<{ id: string; seq: string; hash: string }>`select distinct on (h.key)
      h.key as id,c.seq,h.value as hash from pi_durable_commits c
      cross join lateral jsonb_each_text(c.current_hashes) h
      where ${this.scoped("c")} and h.key=any(${pending.map((r) => String(r.id))}::text[])
      order by h.key,c.seq desc`.execute(tx);
    const checkpoints = pending.map((row) => {
      const latest = state.rows.get(Number(row.id));
      const proof = expected.rows.find((r) => r.id === String(row.id));
      if (
        !latest ||
        !proof ||
        Number(latest.seq) !== Number(proof.seq) ||
        currentStateFingerprint(latest) !== proof.hash
      )
        throw new Error("Native live handoff checkpoint is incomplete or changed");
      return latest;
    });
    await this.#checkpointRows(tx, checkpoints);
    state.rows.clear();
  }
  async #indexBatch(
    tx: Transaction<Database>,
    batch: DurableBatch,
    effective: ReadonlyMap<number, Record<string, string> | undefined>,
    omitted: ReadonlySet<number> = new Set(),
    positions?: readonly number[],
  ): Promise<void> {
    const view = new DurablePostgresProjection(tx, this.scope, undefined, "references");
    const retired = new Set(
      batch.writes
        .filter((w, i) => !omitted.has(i) && w.type === "document.retire")
        .map((w) => (w as Extract<StorageWrite, { type: "document.retire" }>).id),
    );
    // Retire addresses before installing replacements. One batch can update a
    // task repeatedly, so the derived pointer retains its last write only.
    if (retired.size)
      await sql`update pi_durable_records r set retired_seq=${batch.seq}
        where ${this.scoped("r")} and id=any(${[...retired]}::bigint[]) and kind='document'`.execute(
        tx,
      );
    const records = new Map<number, IndexedRecord>();
    const documents: Array<{
      id: number;
      ordinal: number;
      write: Extract<StorageWrite, { type: "document.create" | "document.change" }>;
    }> = [];
    for (const [index, write] of batch.writes.entries()) {
      if (omitted.has(index)) continue;
      const ordinal = positions?.[index] ?? index;
      if (write.type === "document.copy")
        throw new Error("Published document copies must carry their resolved native base");
      if (write.type === "document.retire") continue;
      if (write.type !== "document.change") {
        const kind = write.type === "document.create" ? "document" : write.type;
        const value =
          write.type === "document.create"
            ? ({
                ...write.record,
                createdAt: batch.seq,
                ...(retired.has(write.record.id) ? { retiredAt: batch.seq } : {}),
              } as DocumentRecord)
            : write.value;
        const previous = records.get(value.id);
        if (previous && (previous.kind !== kind || !["task", "submission"].includes(kind)))
          throw new Error("Native record ID ownership changed");
        const record = indexNative(kind, value, batch.seq, ordinal),
          origin = effective.get(value.id);
        if (origin)
          for (const key of ["cloudSession", "run", "turn"] as const)
            if (origin[key]) record.fields[key] = origin[key]!;
        records.set(value.id, record);
      }
      if (write.type === "document.create" || write.type === "document.change")
        documents.push({
          id: write.type === "document.create" ? write.record.id : write.id,
          ordinal,
          write,
        });
    }
    await this.#writeIndexes(tx, [...records.values()]);
    const bases = documents
      .filter((d) => d.write.type === "document.change" && d.write.content.kind === "base")
      .map((d) => d.id);
    if (bases.length)
      await sql`delete from pi_durable_document_revisions d using pi_durable_records r
      where ${this.scoped("r")} and r.id=any(${bases}::bigint[]) and r.fields->>'currentOnly'='true'
        and d.tenant_id=r.tenant_id and d.session_id=r.session_id and d.document_id=r.id`.execute(
        tx,
      );
    if (documents.length) {
      // PG can derive revision metadata in the INSERT itself. Ordinary deltas
      // need no per-document definition/revision SELECT or external cache.
      const inserted = await sql<{
        document_id: string;
        delta_count: number;
      }>`insert into pi_durable_document_revisions
        (tenant_id,session_id,document_id,seq,ordinal,kind,version,delta_count,checkpoint)
        select r.tenant_id,r.session_id,r.id,${batch.seq},v.ordinal,v.kind,v.version,
          case when v.kind='base' then 0 else previous.delta_count+1 end,null
        from (values ${sql.join(documents.map((d) => sql`(${d.id}::bigint,${d.ordinal}::integer,${d.write.content.kind}::text,${d.write.content.version}::integer)`))}) v(id,ordinal,kind,version)
        join pi_durable_records r on r.id=v.id and ${this.scoped("r")} and r.kind='document'
        left join lateral(select version,delta_count from pi_durable_document_revisions d
          where d.tenant_id=r.tenant_id and d.session_id=r.session_id and d.document_id=r.id
          order by seq desc limit 1) previous on true
        where v.kind='base' or previous.version=v.version
        returning document_id,delta_count`.execute(tx);
      if (inserted.rows.length !== documents.length)
        throw new Error("Native document or matching base is missing");
      const byId = new Map(documents.map((d) => [d.id, d.write]));
      for (const row of inserted.rows) {
        if (row.delta_count === 0 || row.delta_count % 64 !== 0) continue;
        const id = Number(row.document_id),
          write = byId.get(id)!;
        if (write.content.kind !== "delta") throw new Error("Invalid native delta checkpoint");
        const record = (await view.get(id))!.value as DocumentRecord;
        const before = materializeNativeDocument(
          record,
          await view.#storedRevisions(id, batch.seq - 1),
        );
        const checkpoint = JSON.stringify(applyImmutableBatches(before.value, [write.content.ops]));
        await sql`update pi_durable_document_revisions d set checkpoint=${checkpoint}
          where ${this.scoped("d")} and document_id=${id} and seq=${batch.seq}`.execute(tx);
      }
    }
    if (retired.size)
      await sql`delete from pi_durable_document_revisions d using pi_durable_records r
      where ${this.scoped("r")} and r.id=any(${[...retired]}::bigint[]) and r.fields->>'currentOnly'='true'
        and d.tenant_id=r.tenant_id and d.session_id=r.session_id and d.document_id=r.id`.execute(
        tx,
      );
  }

  async #writeIndexes(
    tx: Transaction<Database>,
    records: readonly IndexedRecord[],
    current = false,
  ) {
    if (!records.length) return;
    const result = await sql`insert into pi_durable_records as existing
      (tenant_id,session_id,id,kind,seq,ordinal,fields,created_seq,retired_seq) values
      ${sql.join(records.map((r) => sql`(${this.scope.tenantId}::uuid,${this.scope.sessionId},${r.value.id},${r.kind},${r.seq},${r.ordinal},${JSON.stringify(r.fields)}::jsonb,${r.createdSeq ?? null},${r.retiredSeq ?? null})`))}
      on conflict(tenant_id,session_id,id) do update set seq=excluded.seq,ordinal=excluded.ordinal,
        retired_seq=excluded.retired_seq,
        fields=excluded.fields || jsonb_strip_nulls(jsonb_build_object(
          'cloudSession',coalesce(existing.fields->'cloudSession',excluded.fields->'cloudSession'),
          'run',coalesce(existing.fields->'run',excluded.fields->'run'),
          'turn',coalesce(existing.fields->'turn',excluded.fields->'turn')))
      where existing.kind=excluded.kind and (existing.kind in ('task','submission') or
        (${current} and existing.kind='document' and existing.created_seq=excluded.created_seq)) returning id`.execute(
      tx,
    );
    if (result.rows.length !== records.length)
      throw new Error("Native record ID ownership changed");
  }

  /** Rebuild disposable indexes from history AND current state; never a Worker bootstrap. */
  async rebuild(): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await assertIdleNativeSession(tx, this.scope.tenantId, this.scope.sessionId);
      const missing = await sql`with expected as (
        select distinct on (state.key) state.key::bigint as id,c.seq
          from pi_durable_commits c cross join lateral jsonb_each_text(c.current_hashes) state
          where ${this.scoped("c")} order by state.key,c.seq desc
      ), actual as (select id,seq from pi_durable_current c where ${this.scoped("c")})
      select 1 from expected e full join actual a using(id)
        where e.id is null or a.id is null or e.seq<>a.seq limit 1`.execute(tx);
      if (missing.rows.length) throw new Error("Native current-state recovery set is incomplete");
      await sql`delete from pi_durable_records r where ${this.scoped("r")}`.execute(tx);
      await sql`delete from pi_durable_document_revisions r where ${this.scoped("r")}`.execute(tx);
      let afterId = 0;
      for (;;) {
        const rows = await sql<
          CurrentStateRow & { expected: string }
        >`select s.*,c.current_hashes->>s.id::text as expected
          from pi_durable_current s join pi_durable_commits c using(tenant_id,session_id,seq)
          where ${this.scoped("s")} and s.id>${afterId} order by s.id limit 64`.execute(tx);
        if (!rows.rows.length) break;
        for (const row of rows.rows)
          if (currentStateFingerprint(row) !== row.expected)
            throw new Error("Native current-state integrity check failed");
        await this.#writeIndexes(tx, rows.rows.map(currentStateIndex), true);
        afterId = Number(rows.rows.at(-1)!.id);
      }
      let through = 0;
      for (;;) {
        const headers = await sql<{
          seq: string;
          next_id: string;
          write_count: number;
          history_write_count: number;
          history_fingerprint: string;
        }>`select seq,next_id,write_count,history_write_count,history_fingerprint from pi_durable_commits c
          where ${this.scoped("c")} and seq>${through} order by seq limit 128`.execute(tx);
        if (!headers.rows.length) break;
        const rows = await sql<
          HistoryWriteRow & {
            seq: string;
          }
        >`
          select seq,ordinal,record_kind,body,record_id,phase,cloud_origin from pi_durable_log l where ${this.scoped("l")}
          and seq>${through} and seq<=${headers.rows.at(-1)!.seq} order by seq,ordinal`.execute(tx);
        const grouped = new Map<string, typeof rows.rows>();
        for (const row of rows.rows) {
          const group = grouped.get(row.seq) ?? [];
          group.push(row);
          grouped.set(row.seq, group);
        }
        for (const header of headers.rows) {
          const entries = grouped.get(header.seq) ?? [];
          if (
            Number(header.seq) !== ++through ||
            entries.length !== header.history_write_count ||
            entries.some((entry) => entry.ordinal < 0 || entry.ordinal >= header.write_count) ||
            historyFingerprint(entries) !== header.history_fingerprint
          )
            throw new Error("Native retained history integrity check failed");
          const batch = {
            seq: Number(header.seq) as Seq,
            nextId: Number(header.next_id),
            writes: entries.map((row) => JSON.parse(row.body)),
          } as DurableBatch;
          await this.#indexBatch(
            tx,
            batch,
            new Map(entries.map((row) => [Number(row.record_id), row.cloud_origin ?? undefined])),
            new Set(),
            entries.map((row) => row.ordinal),
          );
        }
        through = Number(headers.rows.at(-1)!.seq);
      }
    });
  }
}

export function materializeNativeDocument(
  record: DocumentRecord,
  revisions: readonly DocumentRevision[],
): StoredDocument {
  let base = -1;
  for (let i = 0; i < revisions.length; i++)
    if (revisions[i]!.content.kind === "base" || revisions[i]!.checkpoint !== undefined) base = i;
  if (base < 0) throw new Error(`Document ${record.id} is missing a required base`);
  const first = revisions[base]!,
    content = first.content;
  const value = first.checkpoint ?? (content.kind === "base" ? content.value : undefined);
  if (!value) throw new Error("Native checkpoint base is missing");
  const deltas = revisions.slice(base + 1).map((revision) => {
    if (revision.content.kind !== "delta" || revision.content.version !== content.version)
      throw new Error(`Document ${record.id} crosses a stored version boundary without a base`);
    return revision.content.ops;
  });
  return {
    record,
    version: content.version,
    value: applyImmutableBatches(value, deltas) as JsonObject,
    deltasSinceBase: first.deltaCount + deltas.length,
  };
}
