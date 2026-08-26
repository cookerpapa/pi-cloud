import { describe, expect, it } from "vitest";
import { mappedError } from "../src/api-exception.filter.ts";
import { ControlPlaneStoreError } from "../src/control-plane-store.ts";

describe("API exception mapping", () => {
  it("returns a retryable service status for exhausted Sandbox capacity", () => {
    expect(
      mappedError(new ControlPlaneStoreError("capacity_exhausted", "capacity unavailable")),
    ).toEqual({
      status: 503,
      body: { error: { code: "capacity_exhausted", message: "capacity unavailable" } },
    });
  });
});
