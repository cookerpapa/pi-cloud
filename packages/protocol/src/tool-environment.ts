import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ToolSandboxCreateRequestSchema } from "./tool-sandbox.ts";
import { ImageAttachmentReferenceSchema } from "./image-attachment.ts";
import { ExecutionEvidenceSchema } from "./execution-probe.ts";

/** Frozen logical execution target. No VM endpoint, provider credential or
 * Workspace bytes travel with a Tool intent. requestId names its future binding. */
export const ToolEnvironmentRequestSchema = Type.Object(
  {
    ...Type.Omit(ToolSandboxCreateRequestSchema, ["type", "workspaceSeed"]).properties,
    type: Type.Literal("tool_environment"),
    piSessionId: Type.String({ minLength: 1, maxLength: 512 }),
    conversationId: Type.Integer({ minimum: 1 }),
    workspaceSeedKind: Type.Union([Type.Literal("empty"), Type.Literal("sample_java")]),
  },
  { additionalProperties: false },
);
export type ToolEnvironmentRequest = Static<typeof ToolEnvironmentRequestSchema>;

export function parseToolEnvironmentRequest(value: unknown): ToolEnvironmentRequest {
  if (!Value.Check(ToolEnvironmentRequestSchema, value))
    throw new Error("Invalid logical Tool environment");
  return value;
}

export const PREPARE_ENVIRONMENT_IMAGES_PATH = "/internal/v1/tool-environment/input-images";
/** Fault-only reattachment. Ordinary Tools prepare the environment at dispatch. */
export const RECOVER_TOOL_ENVIRONMENT_PATH = "/internal/v1/tool-environment/recover";
export const EnvironmentImagesRequestSchema = Type.Object(
  {
    environment: ToolEnvironmentRequestSchema,
    images: Type.Array(ImageAttachmentReferenceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type EnvironmentImagesRequest = Static<typeof EnvironmentImagesRequestSchema>;
export function parseEnvironmentImagesRequest(value: unknown): EnvironmentImagesRequest {
  if (!Value.Check(EnvironmentImagesRequestSchema, value))
    throw new Error("Invalid environment image preparation");
  return value;
}
export const EnvironmentImagesResponseSchema = Type.Object(
  {
    images: Type.Array(
      Type.Object(
        {
          sourceId: Type.String(),
          image: ImageAttachmentReferenceSchema,
          hints: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    execution: ExecutionEvidenceSchema,
  },
  { additionalProperties: false },
);
export type EnvironmentImagesResponse = Static<typeof EnvironmentImagesResponseSchema>;
export function parseEnvironmentImagesResponse(value: unknown): EnvironmentImagesResponse {
  if (!Value.Check(EnvironmentImagesResponseSchema, value))
    throw new Error("Invalid prepared environment images");
  return value;
}
