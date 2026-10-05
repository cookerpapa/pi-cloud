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
  currentOnly,
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
  body: string;
  fields: Record<string, string>;
  created_seq: string | null;
  retired_seq: string | null;
};
const decodeRecord = (row: RecordRow): IndexedRecord => {
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

/** Derived indexes point into a single canonical write body. This class never
 * allocates IDs/sequences and never makes an execution or replay decision. */
export class DurablePostgresProjection {
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
  async head(): Promise<{ seq: number; nextId: number }> {
    const result = await sql<{
      seq: string;
      next_id: string;
    }>`select seq,next_id from pi_durable_commits c
      where ${this.scoped("c")} order by seq desc limit 1`.execute(this.database);
    return result.rows[0]
      ? { seq: Number(result.rows[0].seq), nextId: Number(result.rows[0].next_id) }
      : { seq: 0, nextId: 2 };
  }
  async get(id: number): Promise<IndexedRecord | undefined> {
    const result =
      await sql<RecordRow>`select r.kind,r.seq,r.ordinal,r.fields,r.created_seq,r.retired_seq,l.body
      from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
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
    for (const [key, value] of Object.entries(query.fields ?? {}))
      clauses.push(sql`r.fields->>${key}=${value}`);
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
      from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
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
      body: string;
      delta_count: number;
      checkpoint: string | null;
    };
    const result = await sql<RevisionRow>`with base as (
      select seq from pi_durable_document_revisions d where ${this.scoped("d")}
        and document_id=${id} and seq<=${through} and (kind='base' or checkpoint is not null)
      order by seq desc limit 1
    ) select d.seq,d.ordinal,d.delta_count,d.checkpoint,l.body from pi_durable_document_revisions d
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where ${this.scoped("d")} and d.document_id=${id} and d.seq>=(select seq from base) and d.seq<=${through}
      order by d.seq`.execute(this.database);
    return result.rows.map((row) => {
      const write = JSON.parse(row.body) as StorageWrite;
      if (write.type !== "document.create" && write.type !== "document.change")
        throw new Error("Invalid native document pointer");
      return {
        id,
        seq: Number(row.seq),
        ordinal: row.ordinal,
        content: write.content,
        deltaCount: row.delta_count,
        ...(row.checkpoint === null
          ? {}
          : { checkpoint: JSON.parse(row.checkpoint) as JsonObject }),
      };
    });
  }
  async latestRevision(id: number): Promise<{ version: number; deltaCount: number } | undefined> {
    const result = await sql<{
      version: number;
      delta_count: number;
    }>`select version,delta_count from pi_durable_document_revisions d
      where ${this.scoped("d")} and document_id=${id} order by seq desc limit 1`.execute(
      this.database,
    );
    return (
      result.rows[0] && { version: result.rows[0].version, deltaCount: result.rows[0].delta_count }
    );
  }
  async apply(
    batch: DurableBatch | StoredDurableBatch,
    origins: readonly DurableRecordOrigin[] = [],
  ): Promise<boolean> {
    return this.database.transaction().execute((tx) => this.applyIn(tx, batch, origins));
  }
  async applyIn(
    tx: Transaction<Database>,
    stored: DurableBatch | StoredDurableBatch,
    origins: readonly DurableRecordOrigin[] = [],
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
    const prior = await sql<{ fingerprint: string }>`select fingerprint from pi_durable_commits c
      where ${this.scoped("c")} and seq=${batch.seq}`.execute(tx);
    if (prior.rows[0]) {
      if (prior.rows[0].fingerprint !== fingerprint)
        throw new Error("Native commit position changed bytes");
      return false;
    }
    const view = new DurablePostgresProjection(tx, this.scope);
    const head = await view.head();
    if (batch.seq !== head.seq + 1 || batch.nextId < head.nextId)
      throw new Error("Native commit sequence or ID watermark is not contiguous");
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
    await retainSessionImages(tx, this.scope, stored);
    await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count) values(${this.scope.tenantId}::uuid,${this.scope.sessionId},${batch.seq},${batch.nextId},${fingerprint},${batch.writes.length})`.execute(
      tx,
    );
    if (batch.writes.length)
      await sql`insert into pi_durable_log(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin) values
      ${sql.join(
        batch.writes.map((write, ordinal) => {
          const id =
            "value" in write ? write.value.id : "record" in write ? write.record.id : write.id;
          return sql`(${this.scope.tenantId}::uuid,${this.scope.sessionId},${batch.seq},${ordinal},${write.type},${id},${JSON.stringify(write)},${write.type === "task" && "checkpoint" in write.value.state ? (JSON.stringify((write.value.state.checkpoint as { phase?: unknown }).phase) ?? null) : null},${effective.get(id) ? JSON.stringify(Object.fromEntries(["cloudSession", "run", "turn"].map((key) => [key, effective.get(id)![key]]))) : null}::jsonb)`;
        }),
      )}`.execute(tx);
    await this.#indexBatch(tx, batch, effective);
    return true;
  }
  async #indexBatch(
    tx: Transaction<Database>,
    batch: DurableBatch,
    effective: ReadonlyMap<number, Record<string, string> | undefined>,
  ): Promise<void> {
    const view = new DurablePostgresProjection(tx, this.scope, undefined, "references");
    const retired = new Set(
      batch.writes.filter((w) => w.type === "document.retire").map((w) => w.id),
    );
    // Retire addresses before creating their replacements, independent of the
    // caller's write order. Create-and-retire has an empty lifetime.
    for (const id of retired)
      await sql`update pi_durable_records r set retired_seq=${batch.seq}
      where ${this.scoped("r")} and id=${id} and kind='document'`.execute(tx);
    for (const [ordinal, write] of batch.writes.entries()) {
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
        const record = indexNative(kind, value, batch.seq, ordinal);
        const origin = effective.get(value.id);
        if (origin)
          for (const key of ["cloudSession", "run", "turn"] as const)
            if (origin[key]) record.fields[key] = origin[key]!;
        const result = await sql`insert into pi_durable_records as existing
          (tenant_id,session_id,id,kind,seq,ordinal,fields,created_seq,retired_seq) values
          (${this.scope.tenantId}::uuid,${this.scope.sessionId},${value.id},${kind},${batch.seq},${ordinal},${JSON.stringify(record.fields)}::jsonb,${record.createdSeq ?? null},${record.retiredSeq ?? null})
          on conflict(tenant_id,session_id,id) do update set seq=excluded.seq,ordinal=excluded.ordinal,
            fields=excluded.fields || jsonb_strip_nulls(jsonb_build_object(
              'cloudSession',coalesce(existing.fields->'cloudSession',excluded.fields->'cloudSession'),
              'run',coalesce(existing.fields->'run',excluded.fields->'run'),
              'turn',coalesce(existing.fields->'turn',excluded.fields->'turn')))
          where existing.kind=excluded.kind and existing.kind in ('task','submission') returning id`.execute(
          tx,
        );
        if (!result.rows.length) throw new Error("Native record ID ownership changed");
      }
      if (write.type === "document.create" || write.type === "document.change") {
        const id = write.type === "document.create" ? write.record.id : write.id;
        const record = (await view.get(id))?.value as DocumentRecord | undefined;
        if (!record) throw new Error("Native document is missing");
        const previous = await view.latestRevision(id);
        if (write.content.kind === "delta" && previous?.version !== write.content.version)
          throw new Error("Native document delta has no matching base");
        const deltaCount = write.content.kind === "base" ? 0 : previous!.deltaCount + 1;
        let checkpoint: string | null = null;
        if (write.content.kind === "delta" && deltaCount % 64 === 0) {
          const revisions = await view.#storedRevisions(id, batch.seq - 1);
          const before = materializeNativeDocument(record, revisions);
          checkpoint = JSON.stringify(applyImmutableBatches(before.value, [write.content.ops]));
        }
        if (write.content.kind === "base" && currentOnly(record))
          await sql`delete from pi_durable_document_revisions d
          where ${this.scoped("d")} and document_id=${id}`.execute(tx);
        await sql`insert into pi_durable_document_revisions values
          (${this.scope.tenantId}::uuid,${this.scope.sessionId},${id},${batch.seq},${ordinal},${write.content.kind},${write.content.version},${deltaCount},${checkpoint})`.execute(
          tx,
        );
      }
    }
    for (const id of retired) {
      const record = (await view.get(id))?.value as DocumentRecord | undefined;
      if (record && currentOnly(record))
        await sql`delete from pi_durable_document_revisions d
        where ${this.scoped("d")} and document_id=${id}`.execute(tx);
    }
  }

  /** Administrative rebuild of disposable indexes, never a Worker bootstrap. */
  async rebuild(): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await assertIdleNativeSession(tx, this.scope.tenantId, this.scope.sessionId);
      await sql`delete from pi_durable_records r where ${this.scoped("r")}`.execute(tx);
      await sql`delete from pi_durable_document_revisions r where ${this.scoped("r")}`.execute(tx);
      let through = 0;
      for (;;) {
        const headers = await sql<{
          seq: string;
          next_id: string;
        }>`select seq,next_id from pi_durable_commits c
          where ${this.scoped("c")} and seq>${through} order by seq limit 128`.execute(tx);
        if (!headers.rows.length) break;
        const rows = await sql<{
          seq: string;
          body: string;
          record_id: string;
          cloud_origin: Record<string, string> | null;
        }>`
          select seq,body,record_id,cloud_origin from pi_durable_log l where ${this.scoped("l")}
          and seq>${through} and seq<=${headers.rows.at(-1)!.seq} order by seq,ordinal`.execute(tx);
        const grouped = new Map<string, typeof rows.rows>();
        for (const row of rows.rows) {
          const group = grouped.get(row.seq) ?? [];
          group.push(row);
          grouped.set(row.seq, group);
        }
        for (const header of headers.rows) {
          const entries = grouped.get(header.seq) ?? [];
          const batch = {
            seq: Number(header.seq) as Seq,
            nextId: Number(header.next_id),
            writes: entries.map((row) => JSON.parse(row.body)),
          } as DurableBatch;
          await this.#indexBatch(
            tx,
            batch,
            new Map(entries.map((row) => [Number(row.record_id), row.cloud_origin ?? undefined])),
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
