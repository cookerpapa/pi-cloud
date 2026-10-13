import { Type } from "typebox";
import { Value } from "typebox/value";

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

export const ToolResultDataSchema = Type.Unsafe<ToolResultData>(
  Type.Object(
    {
      // Attachment references replace images before transport. The attachment
      // codec validates that representation independently of the Tool protocol.
      content: Type.Array(Type.Unknown()),
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
  ),
);
export const ToolResultPayloadSchema = Type.Unsafe<ToolResultPayload>(
  Type.Object(
    {
      toolCallId: Type.String({ minLength: 1 }),
      toolName: Type.String({ minLength: 1 }),
      result: ToolResultDataSchema,
      isError: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);
export function parseToolResultPayload(value: unknown): ToolResultPayload {
  if (!Value.Check(ToolResultPayloadSchema, value)) throw new Error("Invalid Tool result payload");
  return value as ToolResultPayload;
}
