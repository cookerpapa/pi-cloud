import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Transport settlement budget, not a model/Tool execution timeout or product quota. */
export const TOOL_CANCELLATION_TIMEOUT_MS = 10_000;
const Uuid = Type.String({ format: "uuid" });
export const ToolCancellationSchema = Type.Object(
  {
    activationId: Uuid,
    operationId: Uuid,
    target: Type.Optional(Type.Literal("executor")),
  },
  { additionalProperties: false },
);
export type ToolCancellation = Static<typeof ToolCancellationSchema>;
export type CandidateToolCancellation = ToolCancellation &
  Readonly<{
    executionReference: string;
    conversationId: number;
  }>;
export const AcceptedToolCancellationSchema = Type.Object(
  {
    kind: Type.Literal("tool_cancel"),
    scope: Type.Object(
      {
        tenantId: Uuid,
        sessionId: Uuid,
        turnId: Uuid,
        runId: Uuid,
        fencingToken: Type.Integer({ minimum: 1 }),
        piSessionId: Type.String({ minLength: 1, maxLength: 512 }),
        writerId: Uuid,
      },
      { additionalProperties: false },
    ),
    request: ToolCancellationSchema,
  },
  { additionalProperties: false },
);
export type AcceptedToolCancellation = Static<typeof AcceptedToolCancellationSchema>;
export function parseToolCancellation(value: unknown): AcceptedToolCancellation {
  if (!Value.Check(AcceptedToolCancellationSchema, value))
    throw new TypeError("Invalid Tool cancellation");
  return value as AcceptedToolCancellation;
}
