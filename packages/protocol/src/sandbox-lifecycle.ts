import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema, UtcTimestampSchema } from "./protocol-primitives.ts";
const sequence = Type.String({ pattern: "^(0|[1-9][0-9]{0,18})$" });
const name = Type.String({ minLength: 1, maxLength: 256 });
export const SandboxLifecycleEventSchema = Type.Object(
  {
    eventId: UuidSchema,
    sequence,
    previousSequence: sequence,
    resource: Type.Object(
      {
        kind: Type.Literal("compute"),
        resourceId: name,
        tenantId: UuidSchema,
        workspaceId: UuidSchema,
      },
      { additionalProperties: false },
    ),
    quantity: Type.Object(
      {
        kind: Type.Literal("compute"),
        cpuMillis: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        memoryBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false },
    ),
    incarnation: name,
    sourceBootId: name,
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("paused"),
      Type.Literal("absent"),
      Type.Literal("unknown"),
    ]),
    observedAt: UtcTimestampSchema,
    occurredAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    gapReason: Type.Optional(
      Type.Union([
        Type.Literal("source_restarted"),
        Type.Literal("collection_unavailable"),
        Type.Literal("clock_changed"),
        Type.Literal("provider_observation"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type SandboxLifecycleEvent = Static<typeof SandboxLifecycleEventSchema>;
const page = Type.Object(
  {
    epoch: name,
    sourcePosition: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    low: sequence,
    high: sequence,
    next: sequence,
    gap: Type.Boolean(),
    hasMore: Type.Boolean(),
    events: Type.Array(SandboxLifecycleEventSchema, { maxItems: 256 }),
  },
  { additionalProperties: false },
);
export type SandboxLifecyclePage = Static<typeof page>;
export type SandboxLifecycleCursor = { epoch: string; sequence: string; sourcePosition?: string };
export function parseSandboxLifecyclePage(value: unknown): SandboxLifecyclePage {
  if (!Value.Check(page, value)) throw new TypeError("Invalid sandbox lifecycle history");
  if (
    BigInt(value.low) > BigInt(value.high) + 1n ||
    BigInt(value.next) > BigInt(value.high) ||
    value.hasMore !== BigInt(value.next) < BigInt(value.high)
  )
    throw new TypeError("Invalid lifecycle page boundary");
  let previous: bigint | undefined;
  for (const event of value.events) {
    const seq = BigInt(event.sequence);
    if (
      seq < BigInt(value.low) ||
      seq > BigInt(value.high) ||
      (previous !== undefined && seq !== previous + 1n) ||
      BigInt(event.previousSequence) >= seq ||
      !Number.isFinite(Date.parse(event.observedAt)) ||
      (event.occurredAt !== null &&
        (!Number.isFinite(Date.parse(event.occurredAt)) ||
          Date.parse(event.occurredAt) > Date.parse(event.observedAt)))
    )
      throw new TypeError("Invalid lifecycle observation order");
    previous = seq;
  }
  if (previous !== undefined && previous !== BigInt(value.next))
    throw new TypeError("Lifecycle next cursor changed");
  return value;
}
