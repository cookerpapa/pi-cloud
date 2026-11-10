/** Portable fixed-Guest control. Tool output uses the separate HTTPS callback. */
export const GUEST_EXECUTOR_VERSION = 1;
export const GUEST_EXECUTOR_MAX_INPUT = 1024 * 1024 + 64 * 1024;
export const GUEST_EXECUTOR_MAX_OUTPUT = 8192;
export type GuestPosition = { topic: string; partition: number; offset: string };
export type GuestSubmit = {
  version: 1;
  action: "submit";
  bootId: string;
  operationId: string;
  scopeId: string;
  writerId: string;
  source: GuestPosition;
  timeoutMs: number;
  payload: Record<string, unknown>;
};
export type GuestCancel = {
  version: 1;
  action: "cancel";
  bootId: string;
  scopeId: string;
  writerId: string;
  source: GuestPosition;
  operationId?: string;
};
export type GuestExecutorRequest =
  | GuestSubmit
  | GuestCancel
  | { version: 1; action: "info" }
  | { version: 1; action: "probe"; bootId: string; probeId: string; delivery?: unknown };
export const guestUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function checkedGuestPosition(v: GuestPosition): bigint {
  if (
    !v ||
    !/^[A-Za-z0-9._-]{1,249}$/.test(v.topic) ||
    !Number.isSafeInteger(v.partition) ||
    v.partition < 0 ||
    v.partition > 65535 ||
    typeof v.offset !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(v.offset)
  )
    throw new Error("invalid_execution_position");
  const n = BigInt(v.offset);
  if (n > 9223372036854775807n) throw new Error("invalid_execution_position");
  return n;
}
