import type { UserUpload } from "./user-upload.ts";
import { UserUploadsSchema } from "./user-upload.ts";
import { Type, type Static } from "typebox";
import {
  UuidSchema,
  UtcTimestampSchema,
  NonNegativeSafeIntegerSchema,
} from "./protocol-primitives.ts";
import { MAX_AGENT_INPUT_CHARACTERS } from "./agent-input-budget.ts";

/** PiCloud-owned human-input port; native record/document types stay in Runner. */
export type NativeHumanInput = {
  inputId: string;
  idempotencyKey: string;
  fingerprint: string;
  text: string;
  uploads: UserUpload[];
  mode: "follow_up" | "steer";
  acceptedAt: string;
};
export type NativeInputAction =
  | { action: "edit"; text: string; uploads?: UserUpload[] }
  | { action: "cancel" }
  | { action: "move"; direction: "up" | "down" }
  | { action: "steer"; text?: string };
export type NativeInputMutation = {
  operationId: string;
  fingerprint: string;
  inputId: string;
  revision: string;
  change: NativeInputAction;
};
export type NativeInputItem = {
  inputId: string;
  idempotencyKey: string;
  text: string;
  uploads: UserUpload[];
  acceptedAt: string;
  mailboxPosition: number;
  status: "queued" | "steering";
};
export type NativeInputSnapshot = {
  runId: string;
  revision: string;
  nativeSequence: number;
  hasMore: boolean;
  items: NativeInputItem[];
};
export type NativeInputResult = {
  queue: NativeInputSnapshot;
  replayed: boolean;
  acceptedAt?: string;
};

export type NativeInputCommand = {
  tenantId: string;
  sessionId: string;
  runId: string;
  executionReference: string;
} & (
  | { action: "submit"; input: NativeHumanInput }
  | { action: "mutate"; mutation: NativeInputMutation }
);

export const NATIVE_HUMAN_INPUT_DOCUMENT = "pi-cloud.human-inputs";

const closed = { additionalProperties: false } as const;
const text = Type.String({ maxLength: MAX_AGENT_INPUT_CHARACTERS });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const NativeInputIdSchema = Type.Union([
  UuidSchema,
  Type.String({ pattern: "^input-[0-9a-f]{64}$" }),
]);
const operationId = Type.Union([UuidSchema, Type.String({ pattern: "^edit-[0-9a-f]{64}$" })]);
export const NativeInputAcceptedSchema = Type.Object(
  {
    kind: Type.Literal("input"),
    inputId: NativeInputIdSchema,
    runId: UuidSchema,
    turnId: UuidSchema,
    sessionId: UuidSchema,
    delivery: Type.Union([Type.Literal("follow_up"), Type.Literal("steer")]),
    state: Type.Literal("accepted"),
    acceptedAt: UtcTimestampSchema,
    replayed: Type.Boolean(),
  },
  closed,
);
export type NativeInputAccepted = Static<typeof NativeInputAcceptedSchema>;
const input = Type.Object(
  {
    inputId: NativeInputIdSchema,
    idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
    fingerprint: hash,
    text,
    uploads: UserUploadsSchema,
    mode: Type.Union([Type.Literal("follow_up"), Type.Literal("steer")]),
    acceptedAt: UtcTimestampSchema,
  },
  closed,
);
const change = Type.Union([
  Type.Object(
    { action: Type.Literal("edit"), text, uploads: Type.Optional(UserUploadsSchema) },
    closed,
  ),
  Type.Object({ action: Type.Literal("cancel") }, closed),
  Type.Object(
    {
      action: Type.Literal("move"),
      direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
    },
    closed,
  ),
  Type.Object({ action: Type.Literal("steer"), text: Type.Optional(text) }, closed),
]);
const scope = {
  tenantId: UuidSchema,
  sessionId: UuidSchema,
  runId: UuidSchema,
  executionReference: Type.String({ minLength: 1, maxLength: 512 }),
};
export const NativeInputCommandSchema = Type.Union([
  Type.Object({ ...scope, action: Type.Literal("submit"), input }, closed),
  Type.Object(
    {
      ...scope,
      action: Type.Literal("mutate"),
      mutation: Type.Object(
        {
          operationId,
          fingerprint: hash,
          inputId: NativeInputIdSchema,
          revision: hash,
          change,
        },
        closed,
      ),
    },
    closed,
  ),
]);
export const NativeInputSnapshotSchema = Type.Object(
  {
    runId: UuidSchema,
    revision: hash,
    nativeSequence: NonNegativeSafeIntegerSchema,
    hasMore: Type.Boolean(),
    items: Type.Array(
      Type.Object(
        {
          inputId: NativeInputIdSchema,
          idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
          text,
          uploads: UserUploadsSchema,
          acceptedAt: UtcTimestampSchema,
          mailboxPosition: Type.Integer({ minimum: 1 }),
          status: Type.Union([Type.Literal("queued"), Type.Literal("steering")]),
        },
        closed,
      ),
      { maxItems: 20 },
    ),
  },
  closed,
);
export const NativeInputResultSchema = Type.Object(
  {
    queue: NativeInputSnapshotSchema,
    replayed: Type.Boolean(),
    acceptedAt: Type.Optional(UtcTimestampSchema),
  },
  closed,
);

/** Stable material for a pending-human view revision; caller supplies SHA-256.
 * This is PiCloud-owned data, independent of Storage, the SDK and Node/browser crypto. */
export function humanInputQueueRevisionMaterial(
  items: readonly { id: number; mode: string }[],
  inputs: Readonly<Record<string, { nativeId: number | null; revision: number }>>,
): string {
  const ids = new Map(
    Object.entries(inputs).map(([id, input]) => [input.nativeId, [id, input.revision]]),
  );
  return JSON.stringify(
    items.flatMap((item) => {
      const input = ids.get(item.id);
      return input ? [[...input, item.mode]] : [];
    }),
  );
}
