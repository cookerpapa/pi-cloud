import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  UuidSchema,
  UtcTimestampSchema,
  NonNegativeSafeIntegerSchema as Count,
} from "./protocol-primitives.ts";
import { MAX_AGENT_INPUT_CHARACTERS, assertUserInputBudget } from "./agent-input-budget.ts";

const object = { additionalProperties: false };
export const UsageTokensSchema = Type.Object(
  {
    input: Count,
    output: Count,
    cacheRead: Count,
    cacheWrite: Count,
    total: Count,
  },
  object,
);
export type UsageTokens = Static<typeof UsageTokensSchema>;
const ModelUsageSchema = Type.Object(
  { provider: Type.String(), modelId: Type.String(), tokens: UsageTokensSchema },
  object,
);
export const ConversationUsageResourceSchema = Type.Object(
  {
    sessionId: UuidSchema,
    nativeSequence: Count,
    observedAt: UtcTimestampSchema,
    source: Type.Literal("postgres"),
    inFlight: Type.Boolean(),
    model: Type.Object({ provider: Type.String(), modelId: Type.String() }, object),
    tokens: UsageTokensSchema,
    models: Type.Array(ModelUsageSchema),
    children: Type.Array(
      Type.Object(
        { sessionId: UuidSchema, title: Type.String(), tokens: UsageTokensSchema },
        object,
      ),
    ),
    includingChildren: UsageTokensSchema,
    context: Type.Object(
      {
        estimatedTokens: Type.Union([Count, Type.Null()]),
        window: Type.Union([Count, Type.Null()]),
        compactThreshold: Type.Union([Count, Type.Null()]),
        method: Type.Union([
          Type.Literal("latest_usage"),
          Type.Literal("structural"),
          Type.Literal("unavailable"),
        ]),
      },
      object,
    ),
  },
  object,
);
export type ConversationUsageResource = Static<typeof ConversationUsageResourceSchema>;
export const parseConversationUsageResource = (value: unknown): ConversationUsageResource => {
  if (!Value.Check(ConversationUsageResourceSchema, value))
    throw new TypeError("Invalid conversation usage");
  return value;
};

export const CompactRequestSchema = Type.Object(
  {
    instructions: Type.Optional(Type.String({ maxLength: MAX_AGENT_INPUT_CHARACTERS })),
  },
  object,
);
export type CompactRequest = Static<typeof CompactRequestSchema>;
export function parseCompactRequest(value: unknown): CompactRequest {
  if (!Value.Check(CompactRequestSchema, value)) throw new TypeError("Invalid compact request");
  assertUserInputBudget(value.instructions ?? "");
  return value.instructions?.trim() ? { instructions: value.instructions.trim() } : {};
}
export const CompactStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("summarizing"),
  Type.Literal("awaiting_placement"),
  Type.Literal("applied"),
  Type.Literal("no_op"),
  Type.Literal("stale"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);
export const ConversationCompactResourceSchema = Type.Object(
  {
    commandId: UuidSchema,
    initialOperation: Type.Boolean(),
    sessionId: UuidSchema,
    runId: UuidSchema,
    turnId: UuidSchema,
    state: CompactStateSchema,
    acceptedAt: UtcTimestampSchema,
    nativeSequence: Count,
    replayed: Type.Boolean(),
    error: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  object,
);
export type ConversationCompactResource = Static<typeof ConversationCompactResourceSchema>;
export const parseConversationCompactResource = (value: unknown): ConversationCompactResource => {
  if (!Value.Check(ConversationCompactResourceSchema, value))
    throw new TypeError("Invalid compaction resource");
  return value;
};
export const NativeCompactCommandSchema = Type.Object(
  {
    tenantId: UuidSchema,
    sessionId: UuidSchema,
    runId: UuidSchema,
    executionReference: Type.String({ minLength: 1, maxLength: 512 }),
    commandId: UuidSchema,
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    requestedAt: UtcTimestampSchema,
    instructions: Type.Optional(Type.String({ maxLength: MAX_AGENT_INPUT_CHARACTERS })),
  },
  object,
);
export type NativeCompactCommand = Static<typeof NativeCompactCommandSchema>;
export const NativeCompactResultSchema = Type.Object(
  {
    commandId: UuidSchema,
    replayed: Type.Boolean(),
    taskId: Count,
    nativeSequence: Count,
    requestedAt: UtcTimestampSchema,
    state: CompactStateSchema,
  },
  object,
);
export type NativeCompactResult = Static<typeof NativeCompactResultSchema>;
