import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import { parseImageAttachmentReference, type ImageAttachmentReference } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { ImageAttachmentStore, ImageScope } from "./codec.ts";

export interface ImageBlobStore {
  put(key: string, bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<void>;
  putStream?(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    byteLength: number,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<void>;
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
  readonly #capacityWaiters = new Set<() => void>();
  constructor(
    readonly database: Kysely<Database>,
    readonly blobs: ImageBlobStore,
  ) {}
  async #bounded<T>(bytes: number, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (this.#inFlightBytes > 0 && this.#inFlightBytes + bytes > 128 * 1024 * 1024) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          this.#capacityWaiters.delete(wake);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.#capacityWaiters.delete(wake);
          reject(signal.reason);
        };
        this.#capacityWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    signal.throwIfAborted();
    this.#inFlightBytes += bytes;
    try {
      return await fn();
    } finally {
      this.#inFlightBytes -= bytes;
      for (const wake of [...this.#capacityWaiters]) wake();
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
    return this.#bounded(
      bytes.length,
      async () => {
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
      },
      abort,
    );
  }
  async putStream(
    scope: { tenantId: string; uploadId: string; claimToken: string },
    content: import("@pi-cloud/protocol").UploadContent,
    mimeType: ImageAttachmentReference["mimeType"],
    signal: AbortSignal,
  ): Promise<ImageAttachmentReference> {
    if (!this.blobs.putStream)
      throw new Error("Attachment storage does not support streamed uploads");
    const ref = parseImageAttachmentReference({
      id: randomUUID(),
      sha256: content.sha256,
      byteLength: content.byteLength,
      mimeType,
    });
    // Draft reachability begins before network I/O, so a long progressing upload
    // cannot be mistaken for a day-old orphan by the image reaper.
    await this.database.transaction().execute(async (tx) => {
      await sql`insert into session_image_objects(tenant_id,id,source_run_id,state,sha256,byte_length,mime_type)
      values(${scope.tenantId}::uuid,${ref.id}::uuid,null,'uploading',${ref.sha256},${ref.byteLength},${mimeType})`.execute(
        tx,
      );
      const claim = await tx
        .updateTable("session_uploads")
        .set({ image_id: ref.id, image_reference: { ...ref } })
        .where("id", "=", scope.uploadId)
        .where("tenant_id", "=", scope.tenantId)
        .where("claim_token", "=", scope.claimToken)
        .where("state", "=", "uploading")
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .returning("id")
        .executeTakeFirst();
      if (!claim) throw new Error("Image upload lost its active claim");
    });
    let length = 0,
      complete = false;
    const hash = createHash("sha256");
    const verified = (async function* () {
      for await (const chunk of content.chunks) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        if (length > ref.byteLength) throw new Error("Image upload length changed");
        hash.update(chunk);
        yield chunk;
      }
      if (length !== ref.byteLength || hash.digest("hex") !== ref.sha256)
        throw new Error("Image upload digest changed");
      complete = true;
    })();
    await this.blobs.putStream(
      key(scope.tenantId, ref.id),
      verified,
      ref.byteLength,
      mimeType,
      signal,
    );
    if (!complete) throw new Error("Image upload did not consume the complete stream");
    signal.throwIfAborted();
    const ready =
      await sql`update session_image_objects set state='ready' where tenant_id=${scope.tenantId}::uuid and id=${ref.id}::uuid and state='uploading' returning id`.execute(
        this.database,
      );
    if (!ready.rows.length) throw new Error("Image upload lost its inventory identity");
    return ref;
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
    return this.#bounded(
      ref.byteLength,
      async () => {
        const bytes = await this.blobs.get(objectKey, ref.byteLength, abort);
        if (
          bytes.length !== ref.byteLength ||
          createHash("sha256").update(bytes).digest("hex") !== ref.sha256
        )
          throw new Error("Image attachment integrity check failed");
        return bytes;
      },
      abort,
    );
  }
  async reap(graceMs = 24 * 60 * 60 * 1000, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new Error("Invalid image cleanup grace");
    signal?.throwIfAborted();
    // Draft claims expire independently of Runs; accepted user input is retained
    // with its native Session even before Worker consumption/projection.
    await sql`delete from session_uploads where id in (
      select id from session_uploads where accepted_at is null and expires_at<clock_timestamp()
      order by expires_at limit 32 for update skip locked
    )`.execute(this.database);
    const rows = await this.database.transaction().execute(async (tx) => {
      const { rows: candidates } = await sql<{ tenant_id: string; id: string }>`
        select tenant_id,id from session_image_objects o
        where created_at < clock_timestamp() - ${graceMs} * interval '1 millisecond'
          and not exists(select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from session_uploads u where u.tenant_id=o.tenant_id and u.image_id=o.id)
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
          and not exists(select 1 from session_uploads u where u.tenant_id=o.tenant_id and u.image_id=o.id)
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
