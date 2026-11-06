import assert from "node:assert/strict";

/** The fixture PNG is already compressed, high-entropy content. WebSocket
 * compression can remove base64 overhead, so decoded JSON is not a wire floor. */
export function assertContinuationTraffic({ cold, imageBytes, decodedRequestBytes, sentBytes }) {
  assert([imageBytes, decodedRequestBytes, sentBytes].every(Number.isSafeInteger));
  assert(imageBytes > 0 && decodedRequestBytes > imageBytes && sentBytes >= 0);
  if (cold) assert(sentBytes > imageBytes * 0.8, "Measure real initial image upload");
  assert(
    sentBytes < decodedRequestBytes * (cold ? 1.6 : 0.4),
    "Actual provider network retransmitted historical images",
  );
}
