import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema, UtcTimestampSchema } from "./protocol-primitives.ts";

const name = Type.String({ minLength: 1, maxLength: 256 });
export const ResourceKindSchema = Type.Union([Type.Literal("compute"), Type.Literal("workspace")]);
export const ResourceIdentitySchema = Type.Object(
  {
    kind: ResourceKindSchema,
    resourceId: name,
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
  },
  { additionalProperties: false },
);
export type ResourceIdentity = Static<typeof ResourceIdentitySchema>;

const quantity = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("compute"),
      cpuMillis: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
      memoryBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("workspace"),
      capacityBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);
export const ResourceMeteringEventSchema = Type.Object(
  {
    version: Type.Literal(1),
    eventId: UuidSchema,
    resource: ResourceIdentitySchema,
    sourceId: name,
    sourceBootId: name,
    incarnation: name,
    from: UtcTimestampSchema,
    to: UtcTimestampSchema,
    quality: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("source_restarted"),
        Type.Literal("observation_unavailable"),
        Type.Literal("instance_changed"),
        Type.Literal("clock_changed"),
        Type.Literal("collection_unavailable"),
        Type.Literal("provider_observation"),
      ]),
    ),
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("retained"),
      Type.Literal("paused"),
      Type.Literal("absent"),
      Type.Literal("unknown"),
    ]),
    quantity,
  },
  { additionalProperties: false },
);
export type ResourceMeteringEvent = Static<typeof ResourceMeteringEventSchema>;

const batch = Type.Object(
  { events: Type.Array(ResourceMeteringEventSchema, { minItems: 1, maxItems: 128 }) },
  { additionalProperties: false },
);
export function parseResourceMeteringBatch(value: unknown): { events: ResourceMeteringEvent[] } {
  if (!Value.Check(batch, value)) throw new TypeError("Invalid resource receipt batch");
  for (const event of value.events) {
    if (
      !Number.isFinite(Date.parse(event.from)) ||
      !Number.isFinite(Date.parse(event.to)) ||
      Date.parse(event.to) < Date.parse(event.from) ||
      event.resource.kind !== event.quantity.kind ||
      (event.quality === "unconfirmed") !== (event.reason !== undefined)
    )
      throw new TypeError("Invalid resource receipt interval");
  }
  return value;
}

const price = Type.String({ pattern: "^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$" });
const rateBase = {
  kind: Type.Union([Type.Literal("customer"), Type.Literal("upstream_estimate")]),
  effectiveAt: Type.String({ maxLength: 30 }),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
};
export const ResourceRateInputSchema = Type.Union([
  Type.Object(
    {
      ...rateBase,
      resourceKind: Type.Literal("compute"),
      perHour: Type.Object({ cpuCore: price, memoryGiB: price }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...rateBase,
      resourceKind: Type.Literal("workspace"),
      perHour: Type.Object({ capacityGiB: price }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
]);
export type ResourceRateInput = Static<typeof ResourceRateInputSchema>;
export type ResourceRate = ResourceRateInput & { id: string };
export function parseResourceRateInput(value: unknown): ResourceRateInput {
  if (
    !Value.Check(ResourceRateInputSchema, value) ||
    !Number.isFinite(Date.parse(value.effectiveAt))
  )
    throw new TypeError("Invalid resource rate");
  return { ...value, effectiveAt: new Date(value.effectiveAt).toISOString() };
}

export type ResourcePrice =
  | { state: "unconfirmed" | "unpriced"; reason: string }
  | { state: "priced"; rateId: string; currency: string; amountPico: string };
export type ResourceValuation = {
  from: string;
  to: string;
  customer: ResourcePrice;
  upstream_estimate: ResourcePrice;
};
export type ResourceBillingItem = ResourceMeteringEvent & { valuation: ResourceValuation[] };
export type ResourceBillingPage = {
  items: ResourceBillingItem[];
  next: { time: string; id: string } | null;
};
export type ResourceStatementPage = {
  items: {
    resource: ResourceIdentity;
    firstAt: string;
    lastAt: string;
    confirmedMilliseconds: string;
    unconfirmedMilliseconds: string;
    quantity: ResourceMeteringEvent["quantity"];
    charges: Omit<ResourceBillingSummary["categories"][number], "resourceKind">[];
  }[];
  next: string | null;
};
export type ResourceBillingSummary = {
  collectionEnabled: false;
  categories: {
    resourceKind: string;
    kind: string;
    state: string;
    currency: string | null;
    count: string;
    amountPico: string | null;
  }[];
};
