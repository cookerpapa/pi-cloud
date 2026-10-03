/** A current policy value. Null means no product quota, never a large sentinel. */
export type ResourceLimit = number | null;

export function resourceLimit(value: unknown, name = "Resource limit"): ResourceLimit {
  if (value === undefined || value === null || value === "" || value === "unlimited") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`${name} must be a positive safe integer or unlimited`);
  return parsed;
}

export function limitReached(used: number, limit: ResourceLimit): boolean {
  return limit !== null && used >= limit;
}

export function minimumResourceLimit(...limits: ResourceLimit[]): ResourceLimit {
  const finite = limits.filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
}
