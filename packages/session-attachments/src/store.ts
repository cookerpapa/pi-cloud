import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  parseImageAttachmentReference,
  type ImageAttachmentReference,
} from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { ImageAttachmentStore, ImageScope } from "./codec.ts";

export interface ImageBlobStore {
  put(key: string, bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<void>;
  get(key: string, maximumBytes: number, signal: AbortSignal): Promise<Buffer>;
  delete(key: string, signal: AbortSignal): Promise<void>;
}
type Inventory = {
  tenant_id: string;
  id: string;
  sha256: string;
  byte_length: string;
  mime_type: string;
  state: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function key(tenantId: string, id: string): string {
  if (!UUID.test(tenantId) || !UUID.test(id)) throw new Error("Invalid image attachment scope");
  return `session-images/${tenantId.toLowerCase()}/${id.toLowerCase()}`;
}
function deadline(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** PG owns reachability, S3 owns bytes. Network I/O never holds a PG transaction. */
export class PostgresImageAttachmentStore implements ImageAttachmentStore {
  #inFlightBytes = 0;
  constructor(
    readonly database: Kysely<Database>,
    readonly blobs: ImageBlobStore,
  ) {}
  async #bounded<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
    if (this.#inFlightBytes + bytes > 128 * 1024 * 1024)
      throw new Error("Image attachment transfer capacity exhausted");
    this.#inFlightBytes += bytes;
    try {
      return await fn();
    } finally {
      this.#inFlightBytes -= bytes;
    }
  }
  async put(
    scope: ImageScope,
    bytes: Buffer,
    mimeType: ImageAttachmentReference["mimeType"],
    signal?: AbortSignal,
  ): Promise<ImageAttachmentReference> {
    const ref = parseImageAttachmentReference({
      id: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      mimeType,
    });
    const objectKey = key(scope.tenantId, ref.id);
    const abort = deadline(signal);
    abort.throwIfAborted();
    return this.#bounded(bytes.length, async () => {
      await sql`insert into session_image_objects(tenant_id,id,source_run_id,state,sha256,byte_length,mime_type)
        values(${scope.tenantId}::uuid,${ref.id}::uuid,${scope.runId ?? null}::uuid,'uploading',${ref.sha256},${ref.byteLength},${mimeType})`.execute(
        this.database,
      );
      await this.blobs.put(objectKey, bytes, mimeType, abort);
      abort.throwIfAborted();
      const result = await sql`update session_image_objects set state='ready'
        where tenant_id=${scope.tenantId}::uuid and id=${ref.id}::uuid and state='uploading' returning id`.execute(
        this.database,
      );
      if (!result.rows.length)
        throw new Error("Image attachment upload lost its inventory identity");
      return ref;
    });
  }
  async get(
    tenantId: string,
    reference: ImageAttachmentReference,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const ref = parseImageAttachmentReference(reference);
    const objectKey = key(tenantId, ref.id);
    const abort = deadline(signal);
    abort.throwIfAborted();
    const {
      rows: [row],
    } = await sql<Inventory>`select * from session_image_objects
      where tenant_id=${tenantId}::uuid and id=${ref.id}::uuid`.execute(this.database);
    if (
      !row ||
      row.state !== "ready" ||
      row.sha256 !== ref.sha256 ||
      Number(row.byte_length) !== ref.byteLength ||
      row.mime_type !== ref.mimeType
    )
      throw new Error("Image attachment is unavailable in this tenant");
    return this.#bounded(ref.byteLength, async () => {
      const bytes = await this.blobs.get(
        objectKey,
        Math.min(ref.byteLength, MAX_IMAGE_ATTACHMENT_BYTES),
        abort,
      );
      if (
        bytes.length !== ref.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== ref.sha256
      )
        throw new Error("Image attachment integrity check failed");
      return bytes;
    });
  }
  async reap(graceMs = 24 * 60 * 60 * 1000, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new Error("Invalid image cleanup grace");
    signal?.throwIfAborted();
    const rows = await this.database.transaction().execute(async (tx) => {
      const { rows: candidates } = await sql<{ tenant_id: string; id: string }>`
        select tenant_id,id from session_image_objects o
        where created_at < clock_timestamp() - ${graceMs} * interval '1 millisecond'
          and not exists(select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from runs where id=o.source_run_id and output_sealed_at is null)
        order by created_at limit 32 for update skip locked`.execute(tx);
      if (!candidates.length) return [];
      // A fresh statement after locking observes reference commits which we waited for.
      const { rows } = await sql<{
        tenant_id: string;
        id: string;
      }>`update session_image_objects o set state='deleting'
        where (tenant_id,id) in (${sql.join(candidates.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})
          and not exists(select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from runs where id=o.source_run_id and output_sealed_at is null)
        returning tenant_id,id`.execute(tx);
      return rows;
    });
    for (const row of rows) {
      signal?.throwIfAborted();
      await this.blobs.delete(key(row.tenant_id, row.id), deadline(signal));
      await sql`delete from session_image_objects where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid and state='deleting'`.execute(
        this.database,
      );
    }
    return rows.length;
  }
}
