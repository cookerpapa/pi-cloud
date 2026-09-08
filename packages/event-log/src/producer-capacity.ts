export const DEFAULT_PRODUCER_CAPACITY = Object.freeze({
  maximumPendingBytes: 64 * 1024 * 1024,
  maximumPendingFacts: 4096,
});

export type ProducerCapacity = Readonly<{
  maximumPendingBytes: number;
  maximumPendingFacts: number;
}>;

export function loadProducerCapacity(environment: NodeJS.ProcessEnv): ProducerCapacity {
  const integer = (name: string, fallback: number, maximum: number): number => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new TypeError(`${name} is outside its supported range`);
    return value;
  };
  return {
    maximumPendingBytes: integer(
      "PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES",
      DEFAULT_PRODUCER_CAPACITY.maximumPendingBytes,
      1024 * 1024 * 1024,
    ),
    maximumPendingFacts: integer(
      "PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS",
      DEFAULT_PRODUCER_CAPACITY.maximumPendingFacts,
      65536,
    ),
  };
}
