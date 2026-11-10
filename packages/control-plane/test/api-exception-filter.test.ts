import { describe, expect, it } from "vitest";
import { mappedError } from "../src/api-exception.filter.ts";
import { ControlPlaneStoreError } from "../src/control-plane-store.ts";

describe("API exception mapping", () => {
  it("returns a conflict while a development machine creation is unresolved", () => {
    expect(
      mappedError(
        new ControlPlaneStoreError("development_environment_creation_pending", "pending"),
      ),
    ).toMatchObject({
      status: 409,
      body: { error: { code: "development_environment_creation_pending" } },
    });
  });
  it("returns a retryable service status for exhausted Sandbox capacity", () => {
    expect(
      mappedError(new ControlPlaneStoreError("capacity_exhausted", "capacity unavailable")),
    ).toEqual({
      status: 503,
      body: { error: { code: "capacity_exhausted", message: "capacity unavailable" } },
    });
  });
});
