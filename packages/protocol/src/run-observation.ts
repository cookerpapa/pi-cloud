import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ExecutionEvidenceSchema } from "./execution-probe.ts";

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
export const ProbeBindingSchema = Type.Object(
  {
    bindingId: id,
    scope: RuntimeObservationScopeSchema,
    probe: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ProbeBinding = Static<typeof ProbeBindingSchema>;
export const PathProbeSchema = Type.Object(
  {
    kind: Type.Literal("path_probe"),
    factId: id,
    scope: RuntimeObservationScopeSchema,
    occurredAt: Type.String({ minLength: 20, maxLength: 40 }),
    execution: Type.Optional(
      Type.Object(
        {
          replyTopic: id,
          bindings: Type.Array(ProbeBindingSchema, { maxItems: 64 }),
        },
        { additionalProperties: false },
      ),
    ),
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
export const ExecutionObservationDeliverySchema = Type.Object(
  {
    scope: RuntimeObservationScopeSchema,
    partition: Type.Integer({ minimum: 0 }),
    kind: Type.Union([Type.Literal("probe"), Type.Literal("tool")]),
    requestId: id,
    sentAt: timestamp,
    evidence: ExecutionEvidenceSchema,
    roundTripMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 })),
  },
  { additionalProperties: false },
);
export type ExecutionObservationDelivery = Static<typeof ExecutionObservationDeliverySchema>;
export function parseExecutionObservationDelivery(value: unknown): ExecutionObservationDelivery {
  if (!Value.Check(ExecutionObservationDeliverySchema, value))
    throw new Error("Invalid execution observation");
  return value as ExecutionObservationDelivery;
}
export const ExecutionPathStatusSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("not_applicable"),
      Type.Literal("pending"),
      Type.Literal("confirmed"),
      Type.Literal("unavailable"),
    ]),
    stage: Type.Union([Type.Literal("projector"), Type.Literal("cube"), Type.Literal("worker")]),
    bindingId: Type.Optional(id),
    targetId: Type.Optional(id),
    confirmedAt: Type.Optional(timestamp),
    sentAt: timestamp,
  },
  { additionalProperties: false },
);
export type ExecutionPathStatus = Static<typeof ExecutionPathStatusSchema>;
const identity = {
  sessionId: id,
  turnId: id,
  runId: id,
  // Existing physical Session lease epoch, not a separately allocated UI counter.
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
export const RunObservationSchema = Type.Union([
  Type.Object(
    {
      ...identity,
      type: Type.Literal("run.execution"),
      revision: Type.Integer({ minimum: 1 }),
      observedAt: timestamp,
      execution: ExecutionPathStatusSchema,
    },
    { additionalProperties: false },
  ),
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
