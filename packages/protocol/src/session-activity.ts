import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RuntimeObservationScopeSchema } from "./run-observation.ts";

export const SESSION_ACTIVITY_INTERVAL_MS = 60_000;
export const SESSION_ACTIVITY_FRESH_MS = 45_000;
export const SessionResourceUseSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    computeSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type SessionResourceUse = Static<typeof SessionResourceUseSchema>;
export const SessionActivitySchema = Type.Object(
  {
    kind: Type.Literal("session_activity"),
    factId: Type.String({ minLength: 1, maxLength: 128 }),
    scope: RuntimeObservationScopeSchema,
    occurredAt: Type.String({ minLength: 1, maxLength: 64 }),
    resources: Type.Array(SessionResourceUseSchema, { maxItems: 256 }),
  },
  { additionalProperties: false },
);
export type SessionActivity = Static<typeof SessionActivitySchema>;
export function parseSessionActivity(value: unknown): SessionActivity {
  if (!Value.Check(SessionActivitySchema, value) || !Number.isFinite(Date.parse(value.occurredAt)))
    throw new Error("Invalid Session activity");
  return value;
}
