import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";
import { uploadFileName, uploadRelativePath } from "./user-upload.ts";

/** A transport chunk bound, not a product file-size quota. */
export const WORKSPACE_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_FILE_TRANSFER_PATH = "/internal/v1/workspace-file-transfer";

const length = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const name = Type.String({ minLength: 1, maxLength: 200 });
const path = Type.String({ maxLength: 4096 });
const states = Type.Union([
  Type.Literal("uploading"),
  Type.Literal("ready"),
  Type.Literal("cancelled"),
]);

export const CreateWorkspaceFileTransferSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    workingDirectory: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
    name,
    directory: Type.Optional(path),
    byteLength: length,
    sha256: digest,
  },
  { additionalProperties: false },
);
export type CreateWorkspaceFileTransfer = Static<typeof CreateWorkspaceFileTransferSchema>;

export function workspaceTransferPath(value: string, empty = false): string {
  if (
    (empty && value === "") ||
    (value.length > 0 &&
      value.length <= 4096 &&
      !/[\x00-\x1f\x7f\\]/.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  )
    return value;
  throw new Error("Invalid Workspace transfer path");
}
export function parseCreateWorkspaceFileTransfer(value: unknown): CreateWorkspaceFileTransfer {
  if (!Value.Check(CreateWorkspaceFileTransferSchema, value))
    throw new Error("Invalid Workspace file transfer");
  uploadFileName(value.name);
  if (value.directory !== undefined) workspaceTransferPath(value.directory, true);
  return { ...value, workspaceId: value.workspaceId.toLowerCase() };
}

export const WorkspaceFileTransferRequestSchema = Type.Object(
  {
    fileTransferProtocolVersion: Type.Literal(1),
    type: Type.Literal("workspace.file_transfer"),
    requestId: UuidSchema,
    uploadId: UuidSchema,
    claimToken: UuidSchema,
    tenantId: UuidSchema,
    sessionId: UuidSchema,
    workspaceId: UuidSchema,
    rootPath: path,
    name,
    relativePath: path,
    byteLength: length,
    sha256: digest,
    expiresAt: Type.String({ minLength: 20, maxLength: 32 }),
    createParents: Type.Boolean(),
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("status"),
      Type.Literal("append"),
      Type.Literal("cancel"),
    ]),
    offset: Type.Optional(offset),
    chunkLength: Type.Optional(
      Type.Integer({ minimum: 1, maximum: WORKSPACE_TRANSFER_CHUNK_BYTES }),
    ),
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
export type WorkspaceFileTransferRequest = Static<typeof WorkspaceFileTransferRequestSchema>;
export function parseWorkspaceFileTransferRequest(value: unknown): WorkspaceFileTransferRequest {
  if (!Value.Check(WorkspaceFileTransferRequestSchema, value))
    throw new Error("Invalid Workspace transfer request");
  uploadFileName(value.name);
  workspaceTransferPath(value.relativePath);
  workspaceTransferPath(value.rootPath, true);
  if (
    value.relativePath.split("/").at(-1) !== value.name ||
    (value.createParents &&
      value.relativePath !== uploadRelativePath(value.uploadId, value.name)) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.action === "append"
      ? value.offset === undefined ||
        value.chunkLength === undefined ||
        value.offset + value.chunkLength > value.byteLength
      : value.offset !== undefined || value.chunkLength !== undefined)
  )
    throw new Error("Workspace transfer identity is invalid");
  return value;
}

export const WorkspaceFileTransferSnapshotSchema = Type.Object(
  {
    state: states,
    offset,
    relativePath: path,
  },
  { additionalProperties: false },
);
export type WorkspaceFileTransferSnapshot = Static<typeof WorkspaceFileTransferSnapshotSchema>;
export function parseWorkspaceFileTransferSnapshot(value: unknown): WorkspaceFileTransferSnapshot {
  if (!Value.Check(WorkspaceFileTransferSnapshotSchema, value))
    throw new Error("Invalid Workspace transfer receipt");
  workspaceTransferPath(value.relativePath);
  return value;
}

export const WorkspaceFileTransferSchema = Type.Object(
  {
    id: UuidSchema,
    sessionId: UuidSchema,
    workspaceId: UuidSchema,
    name,
    path: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
    byteLength: length,
    sha256: digest,
    state: states,
    offset,
    expiresAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
);
export type WorkspaceFileTransfer = Static<typeof WorkspaceFileTransferSchema>;
export function parseWorkspaceFileTransfer(value: unknown): WorkspaceFileTransfer {
  if (
    !Value.Check(WorkspaceFileTransferSchema, value) ||
    value.offset > value.byteLength ||
    (value.state === "ready" && value.offset !== value.byteLength)
  )
    throw new Error("Invalid Workspace file receipt");
  uploadFileName(value.name);
  return value;
}
