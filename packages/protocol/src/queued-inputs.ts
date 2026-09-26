import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ControlPlaneApiValidationError } from "./control-plane-api.ts";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const MAX_QUEUED_INPUTS = 64;
const Text = Type.String({ minLength: 1, maxLength: 100_000 });
const Revision = NonNegativeSafeIntegerSchema;
const options = { additionalProperties: false } as const;
export const QueuedInputActionSchema = Type.Union([
  Type.Object({ action: Type.Literal("edit"), revision: Revision, text: Text }, options),
  Type.Object({ action: Type.Literal("cancel"), revision: Revision }, options),
  Type.Object(
    {
      action: Type.Literal("move"),
      revision: Revision,
      direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
    },
    options,
  ),
  Type.Object(
    {
      action: Type.Literal("steer"),
      revision: Revision,
      targetTurnId: UuidSchema,
      text: Type.Optional(Text),
    },
    options,
  ),
]);
export const QueuedInputResourceSchema = Type.Object(
  {
    turnId: UuidSchema,
    runId: UuidSchema,
    text: Text,
    mailboxPosition: PositiveSafeIntegerSchema,
    acceptedAt: UtcTimestampSchema,
    status: Type.Union([Type.Literal("queued"), Type.Literal("steering")]),
  },
  options,
);
export const InputQueueResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    revision: Revision,
    activeTurnId: Type.Union([UuidSchema, Type.Null()]),
    items: Type.Array(QueuedInputResourceSchema, { maxItems: MAX_QUEUED_INPUTS }),
  },
  options,
);
export const QueuedInputActionResultSchema = Type.Object(
  { queue: InputQueueResourceSchema, replayed: Type.Boolean() },
  options,
);
export type QueuedInputAction = Static<typeof QueuedInputActionSchema>;
export type QueuedInputResource = Static<typeof QueuedInputResourceSchema>;
export type InputQueueResource = Static<typeof InputQueueResourceSchema>;
export type QueuedInputActionResult = Static<typeof QueuedInputActionResultSchema>;
function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value))
    throw new ControlPlaneApiValidationError("Invalid pending input request or response");
  return value as Static<T>;
}
export const parseQueuedInputAction = (value: unknown): QueuedInputAction =>
  parse(QueuedInputActionSchema, value);
export const parseInputQueueResource = (value: unknown): InputQueueResource =>
  parse(InputQueueResourceSchema, value);
export const parseQueuedInputActionResult = (value: unknown): QueuedInputActionResult =>
  parse(QueuedInputActionResultSchema, value);
