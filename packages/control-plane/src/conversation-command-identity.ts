import { createHash } from "node:crypto";

export function compactFingerprint(instructions = ""): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, kind: "compact", instructions }))
    .digest("hex");
}
export function compactCommandId(tenantId: string, sessionId: string, key: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(["pi-cloud.compact.v1", tenantId, sessionId, key]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function compactRunState(
  state: string,
  stopReason: string | null,
): import("@pi-cloud/protocol").ConversationCompactResource["state"] {
  if (state === "completed")
    return stopReason === "compact_no_op"
      ? "no_op"
      : stopReason === "compact_stale"
        ? "stale"
        : "applied";
  if (state === "cancelled") return "cancelled";
  if (state === "failed" || state === "timed_out") return "failed";
  return state === "queued" ? "queued" : "summarizing";
}
