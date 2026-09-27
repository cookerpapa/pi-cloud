import { Type, type Static } from "typebox";

// Initial provisioning bundles only; existing Workspace bytes live in Cube Volumes.
export const MAX_WORKSPACE_BLOB_BYTES = 32 * 1_024 * 1_024;

const MAX_BASE64_WORKSPACE_BLOB_LENGTH = Math.ceil(MAX_WORKSPACE_BLOB_BYTES / 3) * 4;

const Sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const WorkspaceBlobSchema = Type.Object(
  {
    encoding: Type.Literal("base64"),
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({
      minimum: 1,
      maximum: MAX_WORKSPACE_BLOB_BYTES,
    }),
    data: Type.String({ minLength: 4, maxLength: MAX_BASE64_WORKSPACE_BLOB_LENGTH }),
  },
  { additionalProperties: false },
);

export const AgentWorkspaceSeedSchema = Type.Union([
  Type.Object({ kind: Type.Literal("sample_java") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("bundle"), bundle: WorkspaceBlobSchema },
    { additionalProperties: false },
  ),
]);

export type AgentWorkspaceSeed = Static<typeof AgentWorkspaceSeedSchema>;
export type WorkspaceBlob = Static<typeof WorkspaceBlobSchema>;
