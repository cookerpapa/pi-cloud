import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import { withDatabaseReadSignal } from "@pi-cloud/database/client";
import { parseImageAttachmentReference, type ImageAttachmentReference } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { ImageAttachmentSource, ImageAttachmentStore, ImageScope } from "./codec.ts";

export interface ImageBlobStore {
  /** One remote attempt per call. Failure ends local transmission; a completed
   * body with a lost receipt may still commit remotely. No partial objects. */
  put(key: string, bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<void>;
  putStream?(
    key: string,
    chunks: AsyncIterable<Uint8Array>,
    byteLength: number,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<void>;
  readStream(key: string, maximumBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
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
export class PostgresImageAttachmentStore implements ImageAttachmentStore, ImageAttachmentSource {
  #inFlightBytes = 0;
  readonly #capacityWaiters = new Set<() => void>();
  constructor(
    readonly database: Kysely<Database>,
    readonly blobs: ImageBlobStore,
    readonly readDatabase: Kysely<Database> = database,
  ) {}
  async #writeCompleted(tenantId: string, id: string, ready = true): Promise<boolean> {
    const { rows } = await sql<{ state: string }>`update session_image_objects set
      write_completed_at=clock_timestamp(),state=case when state='uploading' and ${ready} then 'ready' else state end
      where tenant_id=${tenantId}::uuid and id=${id}::uuid returning state`.execute(this.database);
    return rows[0]?.state === "ready";
  }
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
        if (abort.aborted) {
          await this.#writeCompleted(scope.tenantId, ref.id, false);
          abort.throwIfAborted();
        }
        await this.blobs.put(objectKey, bytes, mimeType, abort);
        const ready = await this.#writeCompleted(scope.tenantId, ref.id);
        abort.throwIfAborted();
        if (!ready) throw new Error("Image attachment upload lost its inventory identity");
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
    if (signal.aborted) {
      await this.#writeCompleted(scope.tenantId, ref.id, false);
      signal.throwIfAborted();
    }
    try {
      await this.blobs.putStream(
        key(scope.tenantId, ref.id),
        verified,
        ref.byteLength,
        mimeType,
        signal,
      );
    } catch (error) {
      // S3 cannot publish a partial PutObject. length counts bytes before they
      // are yielded to the sole transport attempt; unconsumed bytes cannot
      // arrive after that attempt has stopped. A fully transmitted body is
      // deliberately still uncertain when its receipt is lost.
      if (length < ref.byteLength) await this.#writeCompleted(scope.tenantId, ref.id, false);
      throw error;
    }
    const ready = await this.#writeCompleted(scope.tenantId, ref.id, complete);
    if (!complete) throw new Error("Image upload did not consume the complete stream");
    signal.throwIfAborted();
    if (!ready) throw new Error("Image upload lost its inventory identity");
    return ref;
  }
  async get(
    tenantId: string,
    reference: ImageAttachmentReference,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const abort = deadline(signal);
    const ref = await this.#readReference(tenantId, reference, abort);
    return this.#bounded(
      ref.byteLength,
      () =>
        this.#consume(
          tenantId,
          ref,
          async (chunks) => {
            const bytes: Buffer[] = [];
            for await (const chunk of chunks) bytes.push(Buffer.from(chunk));
            return Buffer.concat(bytes, ref.byteLength);
          },
          abort,
        ),
      abort,
    );
  }

  async #readReference(
    tenantId: string,
    reference: ImageAttachmentReference,
    signal?: AbortSignal,
  ) {
    const ref = parseImageAttachmentReference(reference);
    signal?.throwIfAborted();
    const {
      rows: [row],
    } = await withDatabaseReadSignal(signal, () =>
      sql<Inventory>`select * from session_image_objects
      where tenant_id=${tenantId}::uuid and id=${ref.id}::uuid`.execute(this.readDatabase),
    );
    if (
      !row ||
      row.state !== "ready" ||
      row.sha256 !== ref.sha256 ||
      Number(row.byte_length) !== ref.byteLength ||
      row.mime_type !== ref.mimeType
    )
      throw new Error("Image attachment is unavailable in this tenant");
    signal?.throwIfAborted();
    return ref;
  }

  async withStream<T>(
    tenantId: string,
    reference: ImageAttachmentReference,
    consume: (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const ref = await this.#readReference(tenantId, reference, signal);
    return this.#consume(tenantId, ref, consume, signal);
  }

  async #consume<T>(
    tenantId: string,
    ref: ImageAttachmentReference,
    consume: (chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const source = this.blobs.readStream(key(tenantId, ref.id), ref.byteLength, combined);
    let complete = false;
    const verified = (async function* () {
      let length = 0;
      let last: Uint8Array | undefined;
      const hash = createHash("sha256");
      for await (const chunk of source) {
        combined.throwIfAborted();
        length += chunk.byteLength;
        if (length > ref.byteLength) throw new Error("Image attachment integrity check failed");
        hash.update(chunk);
        if (last) yield last;
        last = chunk;
      }
      if (length !== ref.byteLength || hash.digest("hex") !== ref.sha256)
        throw new Error("Image attachment integrity check failed");
      complete = true;
      if (last) yield last;
    })();
    try {
      const value = await consume(verified, combined);
      combined.throwIfAborted();
      if (!complete) throw new Error("Image consumer did not verify the complete source");
      return value;
    } finally {
      controller.abort();
      await verified.return(undefined).catch(() => {});
    }
  }
  async reap(graceMs = 24 * 60 * 60 * 1000, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new Error("Invalid image cleanup grace");
    signal?.throwIfAborted();
    // Draft claims expire independently of Runs; accepted user input is retained
    // with its native Session even before Worker consumption/projection.
    await sql`delete from session_uploads where id in (
      select id from session_uploads u where accepted_at is null and expires_at<clock_timestamp()
        and (state<>'uploading' or lease_expires_at<=clock_timestamp())
        and not exists(select 1 from session_upload_pins p where p.upload_id=u.id)
      order by expires_at limit 32 for update skip locked
    )`.execute(this.database);
    const rows = await this.database.transaction().execute(async (tx) => {
      const { rows: candidates } = await sql<{ tenant_id: string; id: string }>`
        select tenant_id,id from session_image_objects o
        where created_at < clock_timestamp() - ${graceMs} * interval '1 millisecond'
          and cleanup_available_at <= clock_timestamp()
          and not exists(select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from pi_history_record_images r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from pi_history_header_images r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from session_uploads u where u.tenant_id=o.tenant_id and u.image_id=o.id)
          and not exists(select 1 from runs where id=o.source_run_id and output_sealed_at is null)
        order by cleanup_available_at,created_at limit 32 for update skip locked`.execute(tx);
      if (!candidates.length) return [];
      // A fresh statement after locking observes reference commits which we waited for.
      const { rows } = await sql<{
        tenant_id: string;
        id: string;
        write_completed_at: Date | null;
      }>`update session_image_objects o set state='deleting'
        where (tenant_id,id) in (${sql.join(candidates.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})
          and not exists(select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from pi_history_record_images r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from pi_history_header_images r where r.tenant_id=o.tenant_id and r.image_id=o.id)
          and not exists(select 1 from session_uploads u where u.tenant_id=o.tenant_id and u.image_id=o.id)
          and not exists(select 1 from runs where id=o.source_run_id and output_sealed_at is null)
        returning tenant_id,id,write_completed_at`.execute(tx);
      return rows;
    });
    const failures: unknown[] = [];
    let deleted = 0;
    for (const row of rows) {
      signal?.throwIfAborted();
      try {
        await this.blobs.delete(key(row.tenant_id, row.id), deadline(signal));
        // Completion must have been known BEFORE this DELETE. A PUT that
        // completes between the network delete and this statement needs another
        // delete pass, even if its local callback has now recorded completion.
        if (row.write_completed_at !== null) {
          const removed =
            await sql`delete from session_image_objects where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid and state='deleting' and write_completed_at is not null returning id`.execute(
              this.database,
            );
          deleted += removed.rows.length;
        } else {
          await sql`update session_image_objects set cleanup_available_at=clock_timestamp()+interval '1 minute'
            where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid and state='deleting'`.execute(
            this.database,
          );
        }
      } catch (error) {
        signal?.throwIfAborted();
        await sql`update session_image_objects set
          cleanup_available_at=clock_timestamp()+least(300,power(2,least(cleanup_failures,8))) * interval '1 second',
          cleanup_failures=least(cleanup_failures+1,16)
          where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid and state='deleting'`.execute(
          this.database,
        );
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Image cleanup deferred failed objects");
    return deleted;
  }
}
