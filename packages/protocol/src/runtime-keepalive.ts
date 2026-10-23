import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RuntimeObservationScopeSchema } from "./run-observation.ts";

export const RuntimeKeepaliveResourceSchema = Type.Object(
  {
    workspaceId: Type.String({ format: "uuid" }),
    computeSessionId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);
export type RuntimeKeepaliveResource = Static<typeof RuntimeKeepaliveResourceSchema>;
/** Resource-retention intent, separate from diagnostic path/guest evidence. */
export const RuntimeKeepaliveSchema = Type.Object(
  {
    kind: Type.Literal("runtime_keepalive"),
    factId: Type.String({ format: "uuid" }),
    scope: RuntimeObservationScopeSchema,
    occurredAt: Type.String({ minLength: 20, maxLength: 40 }),
    resources: Type.Array(RuntimeKeepaliveResourceSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type RuntimeKeepalive = Static<typeof RuntimeKeepaliveSchema>;
export function parseRuntimeKeepalive(value: unknown): RuntimeKeepalive {
  if (!Value.Check(RuntimeKeepaliveSchema, value) || !Number.isFinite(Date.parse(value.occurredAt)))
    throw new Error("Invalid runtime keepalive");
  return value as RuntimeKeepalive;
}
