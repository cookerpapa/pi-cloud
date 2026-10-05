import { Type } from "typebox";
import { Value } from "typebox/value";

/** PiCloud's fixed guest transport; only the trusted Harness makes the result canonical. */
export type NativeToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details?: unknown;
};
export type NativeToolUpdate = {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: NativeToolResult;
};
export type NativeToolEnd = {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: NativeToolResult;
  isError: boolean;
};
export type NativeToolEvent = NativeToolUpdate | NativeToolEnd;

const result = Type.Unsafe<NativeToolResult>(
  Type.Object({ content: Type.Array(Type.Unknown()), details: Type.Optional(Type.Unknown()) }),
);
const identity = { toolCallId: Type.String(), toolName: Type.String() };
export const NativeToolEventSchema = Type.Unsafe<NativeToolEvent>(
  Type.Union([
    Type.Object({
      ...identity,
      type: Type.Literal("tool_execution_update"),
      args: Type.Unknown(),
      partialResult: result,
    }),
    Type.Object({
      ...identity,
      type: Type.Literal("tool_execution_end"),
      result,
      isError: Type.Boolean(),
    }),
  ]),
);

export function parseNativeToolEvent(value: unknown): NativeToolEvent {
  if (!Value.Check(NativeToolEventSchema, value)) throw new Error("Invalid native Tool event");
  return value as NativeToolEvent;
}
