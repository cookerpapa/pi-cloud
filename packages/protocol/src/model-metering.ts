import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  UuidSchema,
  UtcTimestampSchema,
  NonNegativeSafeIntegerSchema as Count,
} from "./protocol-primitives.ts";

export const MODEL_METERING_HEADER = "x-picloud-metering";
const closed = { additionalProperties: false };
const Name = Type.String({ minLength: 1, maxLength: 256 });
export const ModelMeteringContextSchema = Type.Object(
  {
    version: Type.Literal(1),
    invocationId: UuidSchema,
    tenantId: UuidSchema,
    sessionId: UuidSchema,
    runId: UuidSchema,
    requestedAt: UtcTimestampSchema,
    piSessionId: Type.Optional(Name),
    conversationId: Type.Optional(Count),
    provider: Name,
    model: Name,
    purpose: Type.Union([
      Type.Literal("agent"),
      Type.Literal("context_maintenance"),
      Type.Literal("image"),
    ]),
    operationId: Type.Optional(Name),
  },
  closed,
);
export type ModelMeteringContext = Static<typeof ModelMeteringContextSchema>;
export const MeteredTokensSchema = Type.Object(
  {
    input: Count,
    cacheRead: Count,
    cacheWrite: Count,
    output: Count,
    reasoning: Count,
    unclassified: Count,
    total: Count,
  },
  closed,
);
export const ModelUsageFactSchema = Type.Object(
  {
    model: Name,
    provider: Name,
    serviceTier: Name,
    failed: Type.Boolean(),
    quality: Type.Union([
      Type.Literal("complete"),
      Type.Literal("inconsistent"),
      Type.Literal("unclassified"),
    ]),
    tokens: MeteredTokensSchema,
    imageCount: Type.Optional(Count),
    webSearchRequests: Type.Optional(Count),
    unsupportedDimensions: Type.Boolean(),
  },
  closed,
);
export type ModelUsageFact = Static<typeof ModelUsageFactSchema>;
const common = { context: ModelMeteringContextSchema, occurredAt: UtcTimestampSchema };
export const ModelMeteringEventSchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal("started") }, closed),
  Type.Object({ ...common, kind: Type.Literal("attempt"), executionId: UuidSchema }, closed),
  Type.Object(
    {
      ...common,
      kind: Type.Literal("usage"),
      executionId: UuidSchema,
      usage: ModelUsageFactSchema,
    },
    closed,
  ),
  Type.Object(
    {
      ...common,
      kind: Type.Literal("finished"),
      statusCode: Type.Integer({ minimum: 100, maximum: 599 }),
      cancelled: Type.Boolean(),
    },
    closed,
  ),
  Type.Object({ ...common, kind: Type.Literal("interrupted") }, closed),
]);
export type ModelMeteringEvent = Static<typeof ModelMeteringEventSchema>;
export const ModelMeteringBatchSchema = Type.Object(
  { events: Type.Array(ModelMeteringEventSchema, { minItems: 1, maxItems: 128 }) },
  closed,
);
export function parseModelMeteringBatch(value: unknown): Static<typeof ModelMeteringBatchSchema> {
  if (!Value.Check(ModelMeteringBatchSchema, value))
    throw new TypeError("Invalid model metering batch");
  for (const event of value.events) {
    if (
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      !Number.isFinite(Date.parse(event.context.requestedAt))
    )
      throw new TypeError("Invalid model metering timestamp");
    if (event.kind === "usage") {
      const t = event.usage.tokens;
      if (
        t.input + t.cacheRead + t.cacheWrite + t.output + t.reasoning + t.unclassified !==
        t.total
      )
        throw new TypeError("Model usage categories must be non-overlapping");
      if (event.usage.quality === "complete" && t.unclassified !== 0)
        throw new TypeError("Complete model usage cannot have unclassified tokens");
    }
  }
  return value;
}
export function modelMeteringEventId(event: ModelMeteringEvent): string {
  return `${event.context.invocationId}:${event.kind}${"executionId" in event ? `:${event.executionId}` : ""}`;
}
