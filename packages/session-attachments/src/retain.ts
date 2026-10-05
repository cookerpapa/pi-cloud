import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  IMAGE_OPAQUE_FIELDS,
  parseImageAttachmentReference,
  type ImageAttachmentReference,
} from "@pi-cloud/protocol";

/** Native JSON text can contain NUL/lone surrogates and must not be coerced to
 * PG jsonb merely to find images. Collect bounded references at the trusted
 * projection boundary and retain them in the existing attachment authority. */
export async function retainSessionImages(
  tx: Transaction<Database>,
  scope: { tenantId: string; sessionId: string },
  value: unknown,
): Promise<void> {
  const references = new Map<string, ImageAttachmentReference>();
  const visit = (part: unknown): void => {
    if (!part || typeof part !== "object") return;
    if (Array.isArray(part)) {
      for (const child of part) visit(child);
      return;
    }
    const node = part as Record<string, unknown>;
    if (node.type === "pi_cloud_image_v1") {
      const ref = parseImageAttachmentReference(node.attachment),
        existing = references.get(ref.id);
      if (existing && !isDeepStrictEqual(ref, existing))
        throw new Error("Image reference changed within the commit");
      references.set(ref.id, ref);
      return;
    }
    for (const [key, child] of Object.entries(node))
      if (!IMAGE_OPAQUE_FIELDS.has(key)) visit(child);
  };
  visit(value);
  if (!references.size) return;
  const ids = [...references.keys()].sort();
  const inventory = await sql<{
    id: string;
    sha256: string;
    byte_length: string;
    mime_type: string;
  }>`
    select id,sha256,byte_length,mime_type from session_image_objects
    where tenant_id=${scope.tenantId}::uuid and id=any(${ids}::uuid[]) and state='ready'
    order by id for share`.execute(tx);
  if (
    inventory.rows.length !== references.size ||
    inventory.rows.some((row) => {
      const ref = references.get(row.id)!;
      return (
        row.sha256 !== ref.sha256 ||
        Number(row.byte_length) !== ref.byteLength ||
        row.mime_type !== ref.mimeType
      );
    })
  )
    throw new Error("Native image attachment is unavailable or mismatched");
  await sql`insert into session_image_references(tenant_id,session_id,image_id) values
    ${sql.join(ids.map((id) => sql`(${scope.tenantId}::uuid,${scope.sessionId},${id}::uuid)`))}
    on conflict do nothing`.execute(tx);
}
