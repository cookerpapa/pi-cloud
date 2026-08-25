import { Type, type Static } from "typebox";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^pceg1_([0-9a-f]{32})_([0-9a-f]{32})_([1-9][0-9]{0,15})$/u;

export const ExecutionGrantSchema = Type.String({
  minLength: 73,
  maxLength: 88,
  pattern: "^pceg1_[0-9a-f]{32}_[0-9a-f]{32}_[1-9][0-9]{0,15}$",
});

export type ExecutionGrant = Static<typeof ExecutionGrantSchema>;

export type ExecutionGrantIdentity = Readonly<{
  grantId: string;
  executionId: string;
  generation: number;
}>;

function uuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a UUID`);
  return value.toLowerCase();
}

function compactUuid(value: string, name: string): string {
  return uuid(value, name).replaceAll("-", "");
}

function expandedUuid(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createExecutionGrant(
  grantId: string,
  executionId: string,
  generation: number,
): ExecutionGrant {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("ExecutionGrant generation must be a positive safe integer");
  }
  return `pceg1_${compactUuid(grantId, "ExecutionGrant ID")}_${compactUuid(executionId, "Run execution ID")}_${String(generation)}`;
}

export function parseExecutionGrant(value: unknown): ExecutionGrantIdentity {
  if (typeof value !== "string") throw new TypeError("ExecutionGrant is invalid");
  const match = TOKEN_PATTERN.exec(value);
  if (match === null) throw new TypeError("ExecutionGrant is invalid");
  const generation = Number(match[3]);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("ExecutionGrant is invalid");
  }
  return {
    grantId: expandedUuid(match[1]!),
    executionId: expandedUuid(match[2]!),
    generation,
  };
}
