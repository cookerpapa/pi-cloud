import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const SESSION_CONTROL_OUTBOX_TOPIC = "session.control.changed.v1";
export const SESSION_CONTROL_NOTIFICATION_CHANNEL = "pi_cloud_session_control";

/** A PG-authorized current-state reference, never a native Entry or execution grant. */
const CommonChange = {
  kind: Type.Literal("control_change"),
  factId: Type.String({ format: "uuid" }),
  scope: Type.Object(
    {
      tenantId: Type.String({ format: "uuid" }),
      piSessionId: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  entityId: Type.String({ format: "uuid" }),
  version: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
  occurredAt: Type.String({ minLength: 20, maxLength: 40 }),
};
export const SessionControlChangeSchema = Type.Union([
  Type.Object(
    {
      ...CommonChange,
      entity: Type.Literal("sandbox_binding"),
      runId: Type.String({ format: "uuid" }),
      closed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CommonChange, entity: Type.Literal("input_queue") },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CommonChange, entity: Type.Literal("subagent_state") },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...CommonChange, entity: Type.Literal("subagent_command") },
    { additionalProperties: false },
  ),
]);
export type SessionControlChange = Static<typeof SessionControlChangeSchema>;
export type SandboxBindingChange = Extract<SessionControlChange, { entity: "sandbox_binding" }>;
export type InputQueueChange = Extract<SessionControlChange, { entity: "input_queue" }>;
export function parseSessionControlChange(value: unknown): SessionControlChange {
  if (!Value.Check(SessionControlChangeSchema, value))
    throw new TypeError("Invalid Session control change");
  return value as SessionControlChange;
}

export interface SessionControlPublisher {
  publishControl(change: SessionControlChange): Promise<{ factId: string; durable: true }>;
}
