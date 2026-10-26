import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

export const ExecutionCapabilitySchema = Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,63}$" });
export const ExecutionTargetGrantSchema = Type.Object(
  {
    targetId: UuidSchema,
    revision: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
    kind: Type.Literal("android"),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    capabilities: Type.Array(ExecutionCapabilitySchema, { uniqueItems: true, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ExecutionTargetGrant = Static<typeof ExecutionTargetGrantSchema>;
export const ExecutionTargetGrantsSchema = Type.Array(ExecutionTargetGrantSchema);
export function parseExecutionTargetGrants(value: unknown): ExecutionTargetGrant[] {
  if (
    !Value.Check(ExecutionTargetGrantsSchema, value) ||
    new Set(value.map((v) => v.targetId)).size !== value.length
  )
    throw new TypeError("Invalid execution target grants");
  return value;
}

export const ToolEnvironmentRequirementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("workspace") }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("target"),
      targetKind: Type.Literal("android"),
      capabilities: Type.Array(ExecutionCapabilitySchema, {
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
]);
export type ToolEnvironmentRequirement = Static<typeof ToolEnvironmentRequirementSchema>;

export const ExecutionTargetResourceSchema = Type.Object(
  {
    ...ExecutionTargetGrantSchema.properties,
    boundSessionId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
// Resource fields are intentionally independent from transport endpoints/credentials.
export type ExecutionTargetResource = ExecutionTargetGrant & { boundSessionId: string | null };
export const ExecutionTargetListSchema = Type.Object(
  { targets: Type.Array(ExecutionTargetResourceSchema) },
  { additionalProperties: false },
);
export const SessionExecutionTargetSchema = Type.Object(
  {
    sessionId: UuidSchema,
    revision: Type.String({ pattern: "^[0-9]+$" }),
    target: Type.Union([ExecutionTargetGrantSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export const BindExecutionTargetRequestSchema = Type.Object(
  {
    targetId: Type.Union([UuidSchema, Type.Null()]),
    revision: Type.String({ pattern: "^[0-9]+$" }),
  },
  { additionalProperties: false },
);
export type SessionExecutionTarget = Static<typeof SessionExecutionTargetSchema>;
export function parseExecutionTargetList(value: unknown): { targets: ExecutionTargetResource[] } {
  if (!Value.Check(ExecutionTargetListSchema, value))
    throw new Error("Invalid execution target list");
  return value;
}
export function parseSessionExecutionTarget(value: unknown): SessionExecutionTarget {
  if (!Value.Check(SessionExecutionTargetSchema, value))
    throw new Error("Invalid conversation execution target");
  return value;
}
export function parseBindExecutionTargetRequest(
  value: unknown,
): Static<typeof BindExecutionTargetRequestSchema> {
  if (!Value.Check(BindExecutionTargetRequestSchema, value))
    throw new Error("Invalid execution target binding");
  return value;
}

export type CandidateExecutorToolCommand = Readonly<{
  target: "executor";
  executionReference: string;
  operationId: string;
  bindingId: string;
  toolCallId: string;
  nativeCallId: string;
  conversationId: number;
  toolName: string;
  arguments: Record<string, unknown>;
  occurredAt: string;
}>;
export type ExecutorToolDispatch = Readonly<{
  target: "executor";
  operationId: string;
  bindingId: string;
  taskId: number;
  conversationId: number;
  toolName: string;
  replyTopic: string;
}>;
const ExecutorToolDispatchSchema = Type.Object(
  {
    target: Type.Literal("executor"),
    operationId: UuidSchema,
    bindingId: UuidSchema,
    taskId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    toolName: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    replyTopic: Type.String({ minLength: 1, maxLength: 249 }),
  },
  { additionalProperties: false },
);
export function parseExecutorToolDispatch(value: unknown): ExecutorToolDispatch {
  // Scope is stamped by the trusted publication boundary and checked separately.
  const { scope: _scope, ...descriptor } = value as ExecutorToolDispatch & { scope?: unknown };
  if (!Value.Check(ExecutorToolDispatchSchema, descriptor))
    throw new TypeError("Invalid executor Tool dispatch");
  return descriptor;
}

export type ExecutorCallScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  piSessionId: string;
  writerId: string;
  fencingToken: number;
}>;
export type AcceptedExecutorToolCommand = ExecutorToolDispatch &
  Readonly<{
    kind: "executor_tool";
    scope: ExecutorCallScope;
    nativeCallId: string;
    arguments: Record<string, unknown>;
    operationIndex: number;
  }>;
