import { describe, expect, it } from "vitest";
import { directPrivateEgressCidrs } from "../src/direct-private-egress.ts";

describe("Cube direct private egress configuration", () => {
  it("canonicalizes and deduplicates deployment-owned RFC1918 CIDRs", () => {
    expect(
      directPrivateEgressCidrs([
        "192.168.31.183/24",
        "192.168.31.0/24",
        "10.20.0.1/24",
        "172.20.4.0/24",
      ]),
    ).toEqual(["192.168.31.0/24", "10.20.0.0/24", "172.20.4.0/24"]);
  });

  it("rejects public, link-local and overly broad CIDRs", () => {
    for (const cidr of [
      "0.0.0.0/0",
      "8.8.8.0/24",
      "169.254.0.0/24",
      "192.168.0.0/8",
      "10.0.0.0/16",
    ]) {
      expect(() => directPrivateEgressCidrs([cidr])).toThrow(/RFC1918|invalid/u);
    }
  });
});
