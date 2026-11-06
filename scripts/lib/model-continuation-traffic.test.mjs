import { expect, it } from "vitest";
import { assertContinuationTraffic } from "./model-continuation-traffic.mjs";

const fixture = { imageBytes: 2_300_000, decodedRequestBytes: 3_100_000 };
it("accepts lossless removal of base64 overhead on a cold upload", () => {
  expect(() =>
    assertContinuationTraffic({ ...fixture, cold: true, sentBytes: 2_400_000 }),
  ).not.toThrow();
  expect(() =>
    assertContinuationTraffic({ ...fixture, cold: true, sentBytes: 3_400_000 }),
  ).not.toThrow();
  expect(() => assertContinuationTraffic({ ...fixture, cold: true, sentBytes: 20_000 })).toThrow(
    "initial image upload",
  );
});
it("still rejects a compressed historical image sent again on a warm request", () => {
  expect(() =>
    assertContinuationTraffic({ ...fixture, cold: false, sentBytes: 300_000 }),
  ).not.toThrow();
  expect(() =>
    assertContinuationTraffic({ ...fixture, cold: false, sentBytes: 2_400_000 }),
  ).toThrow("retransmitted historical images");
});
