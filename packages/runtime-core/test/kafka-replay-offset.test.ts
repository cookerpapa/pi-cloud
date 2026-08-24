import { describe, expect, it } from "vitest";
import { replayStartOffset } from "../src/kafka-agent-event-log.ts";

describe("Kafka replay offset normalization", () => {
  it("maps the timestamp API's no-later-record sentinel to the high watermark", () => {
    expect(replayStartOffset("-1", "0")).toBe("0");
    expect(replayStartOffset("-1", "412")).toBe("412");
  });

  it("retains an in-range timestamp offset and clamps an inconsistent future value", () => {
    expect(replayStartOffset("17", "100")).toBe("17");
    expect(replayStartOffset("101", "100")).toBe("100");
  });

  it("rejects unsupported negative and malformed offsets before calling seek", () => {
    expect(() => replayStartOffset("-2", "100")).toThrow("invalid");
    expect(() => replayStartOffset("not-an-offset", "100")).toThrow("invalid");
    expect(() => replayStartOffset("0", "-1")).toThrow("invalid");
  });
});
