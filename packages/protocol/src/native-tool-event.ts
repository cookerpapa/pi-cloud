import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Native Pi payloads, not a second Tool lifecycle. The receiving Pi owns its hooks. */
export type NativeToolUpdate = Omit<
  Extract<AgentEvent, { type: "tool_execution_update" }>,
  "args" | "partialResult"
> & { args: Record<string, unknown>; partialResult: NativeToolResult };
export type NativeToolEnd = Omit<Extract<AgentEvent, { type: "tool_execution_end" }>, "result"> & {
  result: NativeToolResult;
};
export type NativeToolEvent = NativeToolUpdate | NativeToolEnd;
export type NativeToolResult = AgentToolResult<unknown>;

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
