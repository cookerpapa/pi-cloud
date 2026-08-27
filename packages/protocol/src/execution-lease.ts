import { Type, type Static } from "typebox";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^pcel1_([0-9a-f]{32})_([0-9a-f]{32})_([1-9][0-9]{0,15})$/u;

export const ExecutionLeaseSchema = Type.String({
  minLength: 73,
  maxLength: 88,
  pattern: "^pcel1_[0-9a-f]{32}_[0-9a-f]{32}_[1-9][0-9]{0,15}$",
});

export type ExecutionLease = Static<typeof ExecutionLeaseSchema>;

export type ExecutionLeaseIdentity = Readonly<{
  leaseId: string;
  attemptId: string;
  fencingToken: number;
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

export function createExecutionLease(
  leaseId: string,
  attemptId: string,
  fencingToken: number,
): ExecutionLease {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("ExecutionLease fencing token must be a positive safe integer");
  }
  return `pcel1_${compactUuid(leaseId, "ExecutionLease ID")}_${compactUuid(attemptId, "Run attempt ID")}_${String(fencingToken)}`;
}

export function parseExecutionLease(value: unknown): ExecutionLeaseIdentity {
  if (typeof value !== "string") throw new TypeError("ExecutionLease is invalid");
  const match = TOKEN_PATTERN.exec(value);
  if (match === null) throw new TypeError("ExecutionLease is invalid");
  const fencingToken = Number(match[3]);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("ExecutionLease is invalid");
  }
  return {
    leaseId: expandedUuid(match[1]!),
    attemptId: expandedUuid(match[2]!),
    fencingToken,
  };
}
