import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ToolPreviewUpdateSchema,
  parseToolPreviewUpdate,
  previewBytes,
  TOOL_PREVIEW_FRAME_BYTES,
} from "./tool-preview.ts";

export const TOOL_PROGRESS_PATH = "/internal/v1/tool-progress";
export const ToolProgressSchema = Type.Object(
  {
    type: Type.Literal("tool.progress"),
    version: Type.Literal(2),
    sessionId: Type.String(),
    turnId: Type.String(),
    toolCallId: Type.String(),
    operationId: Type.String(),
    update: ToolPreviewUpdateSchema,
  },
  { additionalProperties: false },
);
export type ToolProgress = Static<typeof ToolProgressSchema>;
export const ToolProgressDeliverySchema = Type.Object(
  {
    tenantId: Type.String(),
    partition: Type.Integer({ minimum: 0 }),
    progress: ToolProgressSchema,
  },
  { additionalProperties: false },
);
export type ToolProgressDelivery = Static<typeof ToolProgressDeliverySchema>;
export function parseToolProgress(value: unknown): ToolProgress {
  if (!Value.Check(ToolProgressSchema, value)) throw new Error("Invalid Tool progress");
  const progress = value as ToolProgress;
  parseToolPreviewUpdate(progress.update);
  if (previewBytes(JSON.stringify(progress)) > TOOL_PREVIEW_FRAME_BYTES)
    throw new Error("Tool progress too large");
  return progress;
}
export function parseToolProgressDelivery(value: unknown): ToolProgressDelivery {
  if (!Value.Check(ToolProgressDeliverySchema, value))
    throw new Error("Invalid Tool progress delivery");
  const delivery = value as ToolProgressDelivery;
  parseToolProgress(delivery.progress);
  if (previewBytes(JSON.stringify(delivery)) > TOOL_PREVIEW_FRAME_BYTES)
    throw new Error("Tool progress delivery too large");
  return delivery;
}
