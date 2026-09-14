import { Type, type Static } from "typebox";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^pcer1_([0-9a-f]{32})_([0-9a-f]{32})_([1-9][0-9]{0,15})$/u;

export const ExecutionReferenceSchema = Type.String({
  minLength: 73,
  maxLength: 88,
  pattern: "^pcer1_[0-9a-f]{32}_[0-9a-f]{32}_[1-9][0-9]{0,15}$",
});

export type ExecutionReference = Static<typeof ExecutionReferenceSchema>;

/** Task attribution under a shared Session lease; this is not a separate lease. */
export type ExecutionReferenceIdentity = Readonly<{
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

export function createExecutionReference(
  leaseId: string,
  attemptId: string,
  fencingToken: number,
): ExecutionReference {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("ExecutionReference fencing token must be a positive safe integer");
  }
  return `pcer1_${compactUuid(leaseId, "ExecutionReference ID")}_${compactUuid(attemptId, "Run attempt ID")}_${String(fencingToken)}`;
}

export function parseExecutionReference(value: unknown): ExecutionReferenceIdentity {
  if (typeof value !== "string") throw new TypeError("ExecutionReference is invalid");
  const match = TOKEN_PATTERN.exec(value);
  if (match === null) throw new TypeError("ExecutionReference is invalid");
  const fencingToken = Number(match[3]);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new TypeError("ExecutionReference is invalid");
  }
  return {
    leaseId: expandedUuid(match[1]!),
    attemptId: expandedUuid(match[2]!),
    fencingToken,
  };
}
