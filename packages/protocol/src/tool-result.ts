import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ImageAttachmentReferenceSchema, type ImagePacked } from "./image-attachment.ts";

/** PiCloud result data shared by trusted handlers and the fixed guest adapter.
 * This is a reply to an invocation, never a native lifecycle/history event. */
export type ToolResultData = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details?: unknown;
  diagnostics?: { severity: "info" | "warn" | "error"; message: string; code?: string }[];
};
export type ToolResultPayload = {
  toolCallId: string;
  toolName: string;
  result: ToolResultData;
  isError: boolean;
};

/** Invocation-local transport state, never serialized or a canonical Tool receipt. */
export type ToolReplyWait<T> = Readonly<{
  result: Promise<T>;
  executionSettled(): boolean;
}>;

/** A validated final reply arrived, but its referenced bytes could not be restored. */
export class ToolResultAttachmentError extends Error {
  readonly code = "tool_result_attachment_unavailable";
  constructor(options?: ErrorOptions) {
    super(
      "tool_result_attachment_unavailable: The Tool returned a result, but its image attachment could not be read.",
      options,
    );
    this.name = "ToolResultAttachmentError";
  }
}

const textPart = Type.Object(
  { type: Type.Literal("text"), text: Type.String() },
  { additionalProperties: false },
);
const nativeImagePart = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String({ minLength: 1 }),
    mimeType: ImageAttachmentReferenceSchema.properties.mimeType,
  },
  { additionalProperties: false },
);
const storedImagePart = Type.Object(
  { type: Type.Literal("pi_cloud_image_v1"), attachment: ImageAttachmentReferenceSchema },
  { additionalProperties: false },
);
const resultData = (imagePart: TSchema) =>
  Type.Object(
    {
      content: Type.Array(Type.Union([textPart, imagePart])),
      details: Type.Optional(Type.Unknown()),
      diagnostics: Type.Optional(
        Type.Array(
          Type.Object(
            {
              severity: Type.Union([
                Type.Literal("info"),
                Type.Literal("warn"),
                Type.Literal("error"),
              ]),
              message: Type.String(),
              code: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      ),
    },
    { additionalProperties: false },
  );
export const ToolResultDataSchema = Type.Unsafe<ToolResultData>(resultData(nativeImagePart));
const payload = (result: TSchema) =>
  Type.Object(
    {
      toolCallId: Type.String({ minLength: 1 }),
      toolName: Type.String({ minLength: 1 }),
      result,
      isError: Type.Boolean(),
    },
    { additionalProperties: false },
  );
export const ToolResultPayloadSchema = Type.Unsafe<ToolResultPayload>(
  payload(ToolResultDataSchema),
);
export const PackedToolResultPayloadSchema = Type.Unsafe<ImagePacked<ToolResultPayload>>(
  payload(resultData(storedImagePart)),
);
export function parseToolResultPayload(value: unknown): ToolResultPayload {
  if (!Value.Check(ToolResultPayloadSchema, value)) throw new Error("Invalid Tool result payload");
  return value as ToolResultPayload;
}
export function parsePackedToolResultPayload(value: unknown): ImagePacked<ToolResultPayload> {
  if (!Value.Check(PackedToolResultPayloadSchema, value))
    throw new Error("Invalid packed Tool result payload");
  return value as ImagePacked<ToolResultPayload>;
}
