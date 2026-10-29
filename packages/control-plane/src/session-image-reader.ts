import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { withDatabaseReadSignal } from "@pi-cloud/database/client";
import { parseImageAttachmentReference, type ImageAttachmentReference } from "@pi-cloud/protocol";
import type { ImageAttachmentSource } from "@pi-cloud/session-attachments";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Canonical history or a ready upload ticket grants access within this product Session. */
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
      join session_image_objects o on o.tenant_id=s.tenant_id and o.id=${imageId}::uuid
      where s.tenant_id=${tenantId}::uuid and s.id=${sessionId}::uuid and s.pruned_at is null
        and o.state='ready' and (
          exists(select 1 from session_image_references r where r.tenant_id=s.tenant_id and r.session_id=s.pi_session_id and r.image_id=o.id)
          or exists(select 1 from pi_history_record_images image join pi_durable_writes w
            on w.tenant_id=image.tenant_id and w.retained_record_id=image.retained_record_id
            where image.tenant_id=s.tenant_id and image.image_id=o.id and w.session_id=s.pi_session_id)
          or exists(select 1 from pi_history_header_images image
            join pi_history_view_nodes candidate on candidate.tenant_id=image.tenant_id and candidate.header_body_id=image.body_id
            join pi_history_views v on v.tenant_id=s.tenant_id and v.session_id=s.id
            cross join lateral pi_history_view_ranges(v.tenant_id,v.root_id,candidate.min_position,candidate.max_position) n
            where image.tenant_id=s.tenant_id and image.image_id=o.id and n.header_body_id=image.body_id)
          or exists(select 1 from session_uploads u where u.tenant_id=s.tenant_id and u.session_id=s.id and u.image_id=o.id and u.state='ready'))`.execute(
        this.database,
      ),
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
