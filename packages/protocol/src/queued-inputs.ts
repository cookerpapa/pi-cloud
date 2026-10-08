import { MAX_AGENT_INPUT_CHARACTERS } from "./agent-input-budget.ts";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { ControlPlaneApiValidationError, IdempotencyKeySchema } from "./control-plane-api.ts";
import { UserUploadIdsSchema, UserUploadsSchema } from "./user-upload.ts";
import { NativeInputIdSchema } from "./native-inputs.ts";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

const Text = Type.String({ maxLength: MAX_AGENT_INPUT_CHARACTERS });
const Revision = Type.String({ pattern: "^[0-9a-f]{64}\\.[0-9a-f]{64}$" });
const options = { additionalProperties: false } as const;
export const INPUT_QUEUE_PAGE_SIZE = 20;
export const QueuedInputActionSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("edit"),
      revision: Revision,
      text: Text,
      uploadIds: Type.Optional(UserUploadIdsSchema),
    },
    options,
  ),
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
      text: Type.Optional(Text),
    },
    options,
  ),
]);
export const QueuedInputResourceSchema = Type.Object(
  {
    inputId: NativeInputIdSchema,
    runId: UuidSchema,
    text: Text,
    uploads: Type.Optional(UserUploadsSchema),
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
    hasReturnedInputs: Type.Boolean(),
    viewVersion: Type.String({ pattern: "^(0|[1-9][0-9]{0,38})$" }),
    afterPosition: NonNegativeSafeIntegerSchema,
    hasMore: Type.Boolean(),
    items: Type.Array(QueuedInputResourceSchema, { maxItems: INPUT_QUEUE_PAGE_SIZE }),
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
export const InputQueueObservationSchema = Type.Object(
  { type: Type.Literal("input.queue"), queue: InputQueueResourceSchema },
  options,
);
export type InputQueueObservation = Static<typeof InputQueueObservationSchema>;
export type QueuedInputActionResult = Static<typeof QueuedInputActionResultSchema>;
export const ReturnedInputSchema = Type.Object(
  {
    inputId: NativeInputIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    text: Text,
    uploads: UserUploadsSchema,
    mailboxPosition: PositiveSafeIntegerSchema,
  },
  options,
);
export const ReturnedInputsResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    requestId: Type.Union([UuidSchema, Type.Null()]),
    afterPosition: NonNegativeSafeIntegerSchema,
    pending: Type.Boolean(),
    hasMore: Type.Boolean(),
    items: Type.Array(ReturnedInputSchema, { maxItems: INPUT_QUEUE_PAGE_SIZE }),
  },
  options,
);
export const AcknowledgeReturnedInputsSchema = Type.Object({ requestId: UuidSchema }, options);
export type ReturnedInput = Static<typeof ReturnedInputSchema>;
export type ReturnedInputsResource = Static<typeof ReturnedInputsResourceSchema>;
export type AcknowledgeReturnedInputs = Static<typeof AcknowledgeReturnedInputsSchema>;
function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value))
    throw new ControlPlaneApiValidationError("Invalid pending input request or response");
  return value as Static<T>;
}
export const parseQueuedInputAction = (value: unknown): QueuedInputAction =>
  parse(QueuedInputActionSchema, value);
export const parseQueuedInputId = (value: unknown): string => parse(NativeInputIdSchema, value);
export const parseInputQueueResource = (value: unknown): InputQueueResource =>
  parse(InputQueueResourceSchema, value);
export const parseInputQueueObservation = (value: unknown): InputQueueObservation =>
  parse(InputQueueObservationSchema, value);
export const parseQueuedInputActionResult = (value: unknown): QueuedInputActionResult =>
  parse(QueuedInputActionResultSchema, value);
export const parseReturnedInputsResource = (value: unknown): ReturnedInputsResource =>
  parse(ReturnedInputsResourceSchema, value);
export const parseAcknowledgeReturnedInputs = (value: unknown): AcknowledgeReturnedInputs =>
  parse(AcknowledgeReturnedInputsSchema, value);
