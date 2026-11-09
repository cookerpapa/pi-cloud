import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RuntimeObservationScopeSchema } from "./run-observation.ts";

const EnvironmentChangedSchema = Type.Object(
  {
    kind: Type.Literal("environment_changed"),
    changeId: Type.String({ format: "uuid" }),
    scope: RuntimeObservationScopeSchema,
    bindingId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export type EnvironmentChanged = Static<typeof EnvironmentChangedSchema>;
export function parseEnvironmentChanged(value: unknown): EnvironmentChanged {
  if (!Value.Check(EnvironmentChangedSchema, value)) throw new Error("Invalid environment change");
  return value;
}
