import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const TOOL_PROGRESS_PATH = "/internal/v1/tool-progress";
export const TOOL_PROGRESS_MAX_CHARACTERS = 8192;
export const ToolProgressSchema = Type.Object({
  type: Type.Literal("tool.progress"),
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  operationId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  text: Type.String({ maxLength: TOOL_PROGRESS_MAX_CHARACTERS }),
});
export type ToolProgress = Static<typeof ToolProgressSchema>;
export const ToolProgressDeliverySchema = Type.Object({
  tenantId: Type.String(),
  partition: Type.Integer({ minimum: 0 }),
  progress: ToolProgressSchema,
});
export type ToolProgressDelivery = Static<typeof ToolProgressDeliverySchema>;
export function parseToolProgress(value: unknown): ToolProgress {
  if (!Value.Check(ToolProgressSchema, value)) throw new Error("Invalid Tool progress");
  return value as ToolProgress;
}
export function parseToolProgressDelivery(value: unknown): ToolProgressDelivery {
  if (!Value.Check(ToolProgressDeliverySchema, value))
    throw new Error("Invalid Tool progress delivery");
  return value as ToolProgressDelivery;
}
