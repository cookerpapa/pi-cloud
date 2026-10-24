import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { withDatabaseReadSignal } from "@pi-cloud/database/client";
import { parseImageAttachmentReference, type ImageAttachmentReference } from "@pi-cloud/protocol";
import type { ImageAttachmentSource } from "@pi-cloud/session-attachments";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Read an immutable image only after canonical history retains it in this Session. */
export class SessionImageReader {
  constructor(
    readonly database: Kysely<Database>,
    readonly images?: ImageAttachmentSource,
  ) {}
  async withImage<T>(
    tenantId: string,
    sessionId: string,
    imageId: string,
    consume: (
      image: ImageAttachmentReference,
      chunks: AsyncIterable<Uint8Array>,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (!this.images)
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Session images are unavailable",
      );
    const { rows } = await withDatabaseReadSignal(signal, () =>
      sql<{
        id: string;
        sha256: string;
        byte_length: string;
        mime_type: string;
      }>`select o.id,o.sha256,o.byte_length,o.mime_type from sessions s
      join session_image_references r on r.tenant_id=s.tenant_id and r.session_id=s.pi_session_id
      join session_image_objects o on o.tenant_id=r.tenant_id and o.id=r.image_id
      where s.tenant_id=${tenantId}::uuid and s.id=${sessionId}::uuid and s.pruned_at is null
        and o.id=${imageId}::uuid and o.state='ready'`.execute(this.database),
    );
    const row = rows[0];
    if (!row)
      throw new ControlPlaneStoreError("not_found", "Image is not retained by this conversation");
    const image = parseImageAttachmentReference({
      id: row.id,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mimeType: row.mime_type,
    });
    return this.images.withStream(
      tenantId,
      image,
      (chunks, abort) => consume(image, chunks, abort),
      signal,
    );
  }
}
