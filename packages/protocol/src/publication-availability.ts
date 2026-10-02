/** Disposable admission hint. PG leases and publication fencing remain authoritative. */
export type PublicationAvailability = Readonly<{
  partitionCount: number;
  partitions: readonly number[];
}>;

export function parsePublicationAvailability(value: unknown): PublicationAvailability {
  const v = value as PublicationAvailability | undefined;
  if (
    !v ||
    !Number.isSafeInteger(v.partitionCount) ||
    v.partitionCount < 1 ||
    v.partitionCount > 1024 ||
    !Array.isArray(v.partitions) ||
    v.partitions.length > v.partitionCount ||
    new Set(v.partitions).size !== v.partitions.length ||
    v.partitions.some((p) => !Number.isSafeInteger(p) || p < 0 || p >= v.partitionCount)
  )
    throw new TypeError("Invalid publication availability");
  return { partitionCount: v.partitionCount, partitions: [...v.partitions] };
}
