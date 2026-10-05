import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const ToolExecutionFailureSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
    message: Type.String({ maxLength: 4096 }),
    effect: Type.Union([Type.Literal("not_started"), Type.Literal("unknown")]),
  },
  { additionalProperties: false },
);

export type ToolExecutionFailureData = Static<typeof ToolExecutionFailureSchema>;
export function parseToolExecutionFailure(value: unknown): ToolExecutionFailureData {
  if (!Value.Check(ToolExecutionFailureSchema, value))
    throw new Error("Invalid Tool execution failure");
  return value;
}

/** Raised only from a validated infrastructure envelope, never from Tool text. */
export class ToolExecutionFailure extends Error {
  readonly code: string;
  readonly effect: ToolExecutionFailureData["effect"];
  readonly retryable = false;
  constructor(failure: ToolExecutionFailureData, options?: ErrorOptions) {
    super(`${failure.code}: ${failure.message}`, options);
    this.name = "ToolExecutionFailure";
    this.code = failure.code;
    this.effect = failure.effect;
  }
}
