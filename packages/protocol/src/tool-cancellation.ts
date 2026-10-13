import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Transport settlement budget, not a model/Tool execution timeout or product quota. */
export const TOOL_CANCELLATION_TIMEOUT_MS = 10_000;
export const TOOL_CANCELLATION_UNKNOWN =
  "tool_operation_outcome_unknown: Cancellation was requested but the final Tool result could not be confirmed. The command may still be running or may have already changed files or external services. Inspect its effects before retrying.";

const Uuid = Type.String({ format: "uuid" });
export const ToolCancellationSchema = Type.Object(
  {
    activationId: Uuid,
    operationId: Uuid,
  },
  { additionalProperties: false },
);
export type ToolCancellation = Static<typeof ToolCancellationSchema>;
export type CandidateToolCancellation = ToolCancellation &
  Readonly<{
    executionReference: string;
    conversationId: number;
    occurredAt: string;
  }>;
export const AcceptedToolCancellationSchema = Type.Object(
  {
    kind: Type.Literal("tool_cancel"),
    factId: Uuid,
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
    occurredAt: Type.String({ minLength: 20, maxLength: 40 }),
  },
  { additionalProperties: false },
);
export type AcceptedToolCancellation = Static<typeof AcceptedToolCancellationSchema>;
export function parseToolCancellation(value: unknown): AcceptedToolCancellation {
  if (!Value.Check(AcceptedToolCancellationSchema, value))
    throw new TypeError("Invalid Tool cancellation");
  return value as AcceptedToolCancellation;
}
export interface ToolCancellationPublisher {
  publishToolCancellation(command: CandidateToolCancellation): Promise<void>;
}
