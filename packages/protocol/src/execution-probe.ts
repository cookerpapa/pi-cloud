import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const EXECUTION_PROBE_TIMEOUT_MS = 10_000;
export const EXECUTION_OBSERVATION_PATH = "/internal/v1/execution-observation";
/** Fault-only confirmation of an observed probe against current routing admission. */
export const EXECUTION_READINESS_PATH = "/internal/v1/execution-readiness";
export const RUNTIME_EXECUTION_EVIDENCE_PATH = "/internal/v1/runtime-execution-evidence";
const id = Type.String({ minLength: 1, maxLength: 128 });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** Immutable transport identity; never a Tool Result or an execution grant. */
export const ExecutionEvidenceSchema = Type.Object(
  {
    bindingId: id,
    targetId: id,
    bootId: id,
    observedAt: timestamp,
  },
  { additionalProperties: false },
);
export type ExecutionEvidence = Static<typeof ExecutionEvidenceSchema>;
export function parseExecutionEvidence(value: unknown): ExecutionEvidence {
  if (!Value.Check(ExecutionEvidenceSchema, value)) throw new Error("Invalid execution evidence");
  return value as ExecutionEvidence;
}

export const ExecutionProbeReplySchema = Type.Object(
  {
    kind: Type.Literal("execution_probe"),
    probeId: id,
    sentAt: timestamp,
    guestBootId: id,
    bindingIds: Type.Array(id, { minItems: 1, maxItems: 64, uniqueItems: true }),
    evidence: ExecutionEvidenceSchema,
  },
  { additionalProperties: false },
);
export type ExecutionProbeReply = Static<typeof ExecutionProbeReplySchema>;
export function parseExecutionProbeReply(value: unknown): ExecutionProbeReply {
  if (!Value.Check(ExecutionProbeReplySchema, value))
    throw new Error("Invalid execution probe reply");
  return value as ExecutionProbeReply;
}

export const GuestProbeReplySchema = Type.Object(
  {
    type: Type.Literal("worker.probe_result"),
    probeId: Type.String({ format: "uuid" }),
    guestBootId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export type GuestProbeReply = Static<typeof GuestProbeReplySchema>;
export function parseGuestProbeReply(value: unknown): GuestProbeReply {
  // Guest UUID syntax is deliberately checked without format-registry setup.
  const raw = value as GuestProbeReply | undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !raw ||
    raw.type !== "worker.probe_result" ||
    !uuid.test(raw.probeId) ||
    !uuid.test(raw.guestBootId) ||
    Object.keys(raw).length !== 3
  )
    throw new Error("Invalid guest probe reply");
  return raw;
}
