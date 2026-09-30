import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const RUN_ACTIVITY_PATH = "/internal/v1/run-activity";
export const RUN_PATH_PROBE_INTERVAL_MS = 15_000;
export const RUN_OBSERVATION_STALE_MS = 45_000;
const id = Type.String({ minLength: 1, maxLength: 128 });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const RunPhaseSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("waiting_model"),
  Type.Literal("receiving_model"),
  Type.Literal("preparing_tool"),
  Type.Literal("executing_tool"),
  Type.Literal("waiting_child"),
  Type.Literal("retrying"),
  Type.Literal("compacting"),
  Type.Literal("cancelling"),
  Type.Literal("settling"),
]);
export type RunPhase = Static<typeof RunPhaseSchema>;
export type RunActivityUpdate = { phase: RunPhase; lastActivityAt: number };
export const RuntimeObservationScopeSchema = Type.Object(
  {
    tenantId: id,
    sessionId: id,
    turnId: id,
    runId: id,
    piSessionId: id,
    writerId: id,
    fencingToken: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type RuntimeObservationScope = Static<typeof RuntimeObservationScopeSchema>;
export const PathProbeSchema = Type.Object(
  {
    kind: Type.Literal("path_probe"),
    factId: id,
    scope: RuntimeObservationScopeSchema,
    occurredAt: Type.String({ minLength: 20, maxLength: 40 }),
  },
  { additionalProperties: false },
);
export type PathProbe = Static<typeof PathProbeSchema>;
export function parsePathProbe(value: unknown): PathProbe {
  if (!Value.Check(PathProbeSchema, value) || !Number.isFinite(Date.parse(value.occurredAt)))
    throw new Error("Invalid path probe");
  return value as PathProbe;
}
export const RunActivityDeliverySchema = Type.Object(
  {
    scope: RuntimeObservationScopeSchema,
    partition: Type.Integer({ minimum: 0 }),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    observedAt: timestamp,
    lastActivityAt: timestamp,
    phase: RunPhaseSchema,
  },
  { additionalProperties: false },
);
export type RunActivityDelivery = Static<typeof RunActivityDeliverySchema>;
const identity = { sessionId: id, turnId: id, runId: id };
export const RunObservationSchema = Type.Union([
  Type.Object(
    {
      ...identity,
      type: Type.Literal("run.activity"),
      revision: Type.Integer({ minimum: 1 }),
      observedAt: timestamp,
      lastActivityAt: timestamp,
      phase: RunPhaseSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...identity, type: Type.Literal("run.path"), sentAt: timestamp, observedAt: timestamp },
    { additionalProperties: false },
  ),
]);
export type RunObservation = Static<typeof RunObservationSchema>;
export function parseRunActivityDelivery(value: unknown): RunActivityDelivery {
  if (!Value.Check(RunActivityDeliverySchema, value))
    throw new Error("Invalid Run activity delivery");
  return value as RunActivityDelivery;
}
export function parseRunObservation(value: unknown): RunObservation {
  if (!Value.Check(RunObservationSchema, value)) throw new Error("Invalid Run observation");
  return value as RunObservation;
}
