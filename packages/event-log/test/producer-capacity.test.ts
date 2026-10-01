import { expect, it } from "vitest";
import { loadProducerCapacity } from "../src/producer-capacity.ts";

it("uses one producer capacity configuration contract", () => {
  expect(loadProducerCapacity({})).toEqual({
    maximumPendingBytes: 67108864,
    maximumPendingFacts: 4096,
  });
  expect(
    loadProducerCapacity({
      PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES: "1234",
      PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS: "12",
    }),
  ).toEqual({ maximumPendingBytes: 1234, maximumPendingFacts: 12 });
  expect(() => loadProducerCapacity({ PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS: "0" })).toThrow();
});
