import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ModelMeteringContextSchema, ModelUsageFactSchema } from "./model-metering.ts";
import {
  UuidSchema,
  UtcTimestampSchema,
  NonNegativeSafeIntegerSchema,
} from "./protocol-primitives.ts";

const name = Type.String({ minLength: 1, maxLength: 256 });
const price = Type.String({ pattern: "^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$" });
export const ModelRateInputSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("customer"), Type.Literal("upstream_estimate")]),
    provider: name,
    model: name,
    serviceTier: name,
    effectiveAt: Type.String({ maxLength: 30 }),
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    includeFailed: Type.Boolean(),
    perMillion: Type.Object(
      { input: price, cacheRead: price, cacheWrite: price, output: price, reasoning: price },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ModelRateInput = Static<typeof ModelRateInputSchema>;
export type ModelRate = ModelRateInput & { id: string };
export type ModelPrice =
  | { state: "unconfirmed" | "unpriced"; reason: string }
  | {
      state: "priced" | "waived";
      rateId: string;
      currency: string;
      amountPico: string;
    };
export type ModelValuation = { customer: ModelPrice; upstream_estimate: ModelPrice };
export function parseModelRateInput(value: unknown): ModelRateInput {
  if (!Value.Check(ModelRateInputSchema, value) || !Number.isFinite(Date.parse(value.effectiveAt)))
    throw new TypeError("Invalid model rate");
  return { ...value, effectiveAt: new Date(value.effectiveAt).toISOString() };
}

const PriceSchema = Type.Union([
  Type.Object({
    state: Type.Union([Type.Literal("unconfirmed"), Type.Literal("unpriced")]),
    reason: Type.String(),
  }),
  Type.Object({
    state: Type.Union([Type.Literal("priced"), Type.Literal("waived")]),
    rateId: UuidSchema,
    currency: Type.String(),
    amountPico: Type.String({ pattern: "^[0-9]+$" }),
  }),
]);
export const ModelBillingPageSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      context: ModelMeteringContextSchema,
      state: Type.Union([
        Type.Literal("pending"),
        Type.Literal("unconfirmed"),
        Type.Literal("confirmed"),
      ]),
      missingAttempts: NonNegativeSafeIntegerSchema,
      interrupted: Type.Boolean(),
      usage: Type.Array(
        Type.Object({
          context: ModelMeteringContextSchema,
          kind: Type.Literal("usage"),
          executionId: UuidSchema,
          occurredAt: UtcTimestampSchema,
          usage: ModelUsageFactSchema,
          valuation: Type.Object({ customer: PriceSchema, upstream_estimate: PriceSchema }),
        }),
      ),
    }),
  ),
  next: Type.Union([Type.Null(), Type.Object({ time: UtcTimestampSchema, id: UuidSchema })]),
});
export type ModelBillingPage = Static<typeof ModelBillingPageSchema>;
export function parseModelBillingPage(value: unknown): ModelBillingPage {
  if (!Value.Check(ModelBillingPageSchema, value))
    throw new TypeError("Invalid model billing page");
  return value;
}
export type ModelBillingSummary = {
  collectionEnabled: false;
  categories: {
    kind: string;
    state: string;
    currency: string | null;
    count: string;
    amountPico: string | null;
  }[];
};
