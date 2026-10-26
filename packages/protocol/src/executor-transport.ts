import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";
import { ExecutionCapabilitySchema } from "./execution-target.ts";

const decimal = Type.String({ pattern: "^(0|[1-9][0-9]{0,18})$" });
export const ExecutorBindingSchema = Type.Object(
  {
    bindingId: UuidSchema,
    targetId: UuidSchema,
    bootId: UuidSchema,
    generation: Type.String({ pattern: "^[1-9][0-9]{0,18}$" }),
    tenantId: UuidSchema,
    sessionId: UuidSchema,
    runId: UuidSchema,
    writerId: UuidSchema,
    piSessionId: Type.String({ minLength: 1, maxLength: 512 }),
    fencingToken: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    capabilities: Type.Array(ExecutionCapabilitySchema, { maxItems: 64, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type ExecutorBinding = Static<typeof ExecutorBindingSchema>;
export const ExecutorPositionSchema = Type.Object(
  {
    topic: Type.String({ minLength: 1, maxLength: 249 }),
    partition: Type.Integer({ minimum: 0 }),
    offset: decimal,
    index: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type ExecutorPosition = Static<typeof ExecutorPositionSchema>;
export const ExecutorOperationSchema = Type.Object(
  {
    version: Type.Literal(1),
    binding: ExecutorBindingSchema,
    position: ExecutorPositionSchema,
    operationId: UuidSchema,
    toolName: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    nativeCallId: Type.String({ minLength: 1, maxLength: 512 }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    replyTopic: Type.String({ minLength: 1, maxLength: 249 }),
  },
  { additionalProperties: false },
);
export type ExecutorOperation = Static<typeof ExecutorOperationSchema>;
export const ExecutorCancellationSchema = Type.Object(
  { binding: ExecutorBindingSchema, operationId: UuidSchema, position: ExecutorPositionSchema },
  { additionalProperties: false },
);
export type ExecutorCancellation = Static<typeof ExecutorCancellationSchema>;
export function parseExecutorOperation(value: unknown): ExecutorOperation {
  if (!Value.Check(ExecutorOperationSchema, value)) throw new Error("Invalid executor operation");
  return value;
}
export function parseExecutorBinding(value: unknown): ExecutorBinding {
  if (!Value.Check(ExecutorBindingSchema, value)) throw new Error("Invalid executor binding");
  return value;
}
export function parseExecutorCancellation(value: unknown): ExecutorCancellation {
  if (!Value.Check(ExecutorCancellationSchema, value))
    throw new Error("Invalid executor cancellation");
  return value;
}
export const EXECUTOR_OPERATIONS_PATH = "/internal/v1/executor/operations";
export const EXECUTOR_BINDING_PATH = "/internal/v1/executor/bindings";
export const EXECUTOR_TARGET_BIND_PATH = "/internal/v1/execution-target-bindings";
