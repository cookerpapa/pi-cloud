import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

/** Immutable bytes. This is neither a public URL nor a mutable Workspace path. */
export const AttachmentReferenceSchema = Type.Object(
  {
    id: UuidSchema,
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    byteLength: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    mimeType: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$",
    }),
  },
  { additionalProperties: false },
);
export type AttachmentReference = Static<typeof AttachmentReferenceSchema>;
export const StoredAttachmentReferenceSchema = Type.Object(
  { type: Type.Literal("pi_cloud_attachment_v1"), attachment: AttachmentReferenceSchema },
  { additionalProperties: false },
);
export type StoredAttachmentReference = Static<typeof StoredAttachmentReferenceSchema>;
export function parseAttachmentReference(value: unknown): AttachmentReference {
  if (!Value.Check(AttachmentReferenceSchema, value))
    throw new Error("Invalid attachment reference");
  return value;
}
