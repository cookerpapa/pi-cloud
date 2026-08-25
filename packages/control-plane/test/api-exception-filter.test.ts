import { DurableEventStoreError } from "@pi-cloud/runtime-core/durable-event-store";
import { describe, expect, it } from "vitest";
import { mappedError } from "../src/api-exception.filter.ts";
import { ControlPlaneStoreError } from "../src/control-plane-store.ts";

describe("API event cursor errors", () => {
  it("uses 410 so the browser reloads canonical PostgreSQL messages", () => {
    expect(mappedError(new DurableEventStoreError("cursor_expired", "cursor expired"))).toEqual({
      status: 410,
      body: { error: { code: "cursor_expired", message: "cursor expired" } },
    });
  });

  it("keeps an impossible future cursor as a conflict", () => {
    expect(mappedError(new DurableEventStoreError("cursor_ahead", "cursor ahead")).status).toBe(
      409,
    );
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
