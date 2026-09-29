import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";
import { ImageAttachmentReferenceSchema } from "./image-attachment.ts";

export const MAX_USER_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_USER_UPLOADS = 4;
export const MAX_USER_INPUT_UPLOAD_BYTES = 32 * 1024 * 1024;
export const USER_UPLOAD_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const UserUploadSchema = Type.Object(
  {
    id: UuidSchema,
    sessionId: UuidSchema,
    workspaceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
    mimeType: Type.String({ minLength: 1, maxLength: 128 }),
    byteLength: Type.Integer({ minimum: 1, maximum: MAX_USER_UPLOAD_BYTES }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    image: Type.Optional(ImageAttachmentReferenceSchema),
  },
  { additionalProperties: false },
);
export type UserUpload = Static<typeof UserUploadSchema>;
export const UserUploadsSchema = Type.Array(UserUploadSchema, { maxItems: MAX_USER_UPLOADS });
export const UserUploadIdsSchema = Type.Array(UuidSchema, {
  maxItems: MAX_USER_UPLOADS,
  uniqueItems: true,
});

export const WorkspaceUploadRequestSchema = Type.Object(
  {
    toolBrokerProtocolVersion: Type.Literal(1),
    type: Type.Literal("workspace.upload_file"),
    requestId: UuidSchema,
    uploadId: UuidSchema,
    claimToken: UuidSchema,
    tenantId: UuidSchema,
    sessionId: UuidSchema,
    workspaceId: UuidSchema,
    rootPath: Type.String({ maxLength: 4096 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    machine: Type.Optional(
      Type.Object(
        {
          environmentId: UuidSchema,
          userId: UuidSchema,
          directory: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type WorkspaceUploadRequest = Static<typeof WorkspaceUploadRequestSchema>;
export function parseWorkspaceUploadRequest(value: unknown): WorkspaceUploadRequest {
  if (!Value.Check(WorkspaceUploadRequestSchema, value))
    throw new Error("Invalid Workspace upload request");
  uploadFileName(value.name);
  return value;
}

export function parseUserUpload(value: unknown): UserUpload {
  if (!Value.Check(UserUploadSchema, value)) throw new Error("Invalid uploaded file metadata");
  uploadFileName(value.name);
  return value;
}
export function parseUserUploads(value: unknown): UserUpload[] {
  if (!Value.Check(UserUploadsSchema, value)) throw new Error("Invalid input attachments");
  const uploads = value.map(parseUserUpload);
  if (
    new Set(uploads.map((file) => file.id)).size !== uploads.length ||
    uploads.reduce((sum, file) => sum + file.byteLength, 0) > MAX_USER_INPUT_UPLOAD_BYTES
  )
    throw new Error("Input attachments exceed their budget");
  return uploads;
}
export function uploadFileName(value: string): string {
  if (
    !value ||
    value.length > 200 ||
    new TextEncoder().encode(value).byteLength > 240 ||
    /[\x00-\x1f\x7f/\\]/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("Upload filename is invalid");
  return value;
}
export function uploadRelativePath(id: string, name: string): string {
  if (!Value.Check(UuidSchema, id)) throw new Error("Upload identity is invalid");
  return `uploads/${id}/${uploadFileName(name)}`;
}

/** Display metadata never becomes a system instruction or a fabricated Tool reply. */
export function inputWithUploads(text: string, uploads: readonly UserUpload[]): string {
  if (!uploads.length) return text;
  return `${text}${text ? "\n\n" : ""}User-uploaded files (paths refer to the environment at upload time):\n${uploads
    .map((file, index) =>
      JSON.stringify({
        attachment: index + 1,
        name: file.name,
        path: file.path,
        mimeType: file.mimeType,
        bytes: file.byteLength,
        ...(file.image ? { visualInput: true } : {}),
      }),
    )
    .join("\n")}`;
}
