import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema, UtcTimestampSchema } from "./protocol-primitives.ts";
export const ScheduledOriginSchema = Type.Object(
  {
    kind: Type.Literal("schedule"),
    scheduleId: UuidSchema,
    revision: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    scheduledAt: UtcTimestampSchema,
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export type ScheduledOrigin = Static<typeof ScheduledOriginSchema>;
export function parseScheduledOrigin(value: unknown): ScheduledOrigin {
  if (!Value.Check(ScheduledOriginSchema, value)) throw new TypeError("Invalid scheduled origin");
  return value;
}
