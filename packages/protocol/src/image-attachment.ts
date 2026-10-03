import { Type } from "typebox";
import { Value } from "typebox/value";

export const MAX_IMAGE_GUEST_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Pi treats these fields as opaque user/Tool JSON, never native image parts. */
export const IMAGE_OPAQUE_FIELDS: ReadonlySet<string> = new Set([
  "details",
  "arguments",
  "effectiveArgs",
  "data",
  "resumeData",
]);
export const ImageAttachmentReferenceSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    byteLength: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    mimeType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
    ]),
  },
  { additionalProperties: false },
);
export type ImageAttachmentReference = {
  id: string;
  sha256: string;
  byteLength: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};
export type StoredImageContent = {
  type: "pi_cloud_image_v1";
  attachment: ImageAttachmentReference;
};
/** The wire/storage representation is deliberately distinct from native Pi data. */
export type ImagePacked<T> = T extends { type: "image"; data: string; mimeType: string }
  ? Omit<T, "type" | "data" | "mimeType"> & StoredImageContent
  : T extends readonly (infer U)[]
    ? ImagePacked<U>[]
    : T extends object
      ? { [K in keyof T]: ImagePacked<T[K]> }
      : T;

export function parseImageAttachmentReference(value: unknown): ImageAttachmentReference {
  if (!Value.Check(ImageAttachmentReferenceSchema, value))
    throw new Error("Invalid image attachment reference");
  return value as ImageAttachmentReference;
}

export function validateImageReferencePayload(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) validateImageReferencePayload(item);
    return;
  }
  const part = value as Record<string, unknown>;
  if (part.type === "image" && typeof part.data === "string")
    throw new Error("Inline image bytes are forbidden in Kafka records");
  if (part.type === "pi_cloud_image_v1") parseImageAttachmentReference(part.attachment);
  for (const [key, child] of Object.entries(part))
    if (!IMAGE_OPAQUE_FIELDS.has(key)) validateImageReferencePayload(child);
}
