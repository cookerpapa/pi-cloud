import { describe, expect, it } from "vitest";
import { PostgresQueueWake } from "@pi-cloud/database";
import { familyAdmission } from "../src/postgres-pi-worker.ts";

describe("Session root-work admission", () => {
  const task = (piSessionId: string) => ({
    runId: `root-${piSessionId}`,
    tenantId: "tenant",
    piSessionId,
  });
  it("blocks a second root in every occupied physical Session", () => {
    expect(familyAdmission([task("a")], 2)).toEqual({ blockedFamilyKeys: ["tenant:a"] });
    expect(familyAdmission([task("a"), task("b")], 2)).toEqual({
      allowedFamilyKeys: [],
      blockedFamilyKeys: ["tenant:a", "tenant:b"],
    });
  });
  it("reserves uncommitted claims and stops admission at the memory watermark", () => {
    expect(familyAdmission([], 1, true, 1)).toEqual({
      allowedFamilyKeys: [],
      blockedFamilyKeys: [],
    });
    expect(familyAdmission([task("a")], 2, false)).toEqual({
      allowedFamilyKeys: [],
      blockedFamilyKeys: ["tenant:a"],
    });
    expect(familyAdmission([], 1).allowedFamilyKeys).toBeUndefined();
  });
});

describe("PostgreSQL queue wake-up", () => {
  it("does not lose a notification delivered between queue scan and wait", async () => {
    const wake = new PostgresQueueWake();
    const observed = wake.generation;
    wake.notify();
    let settled = false;
    const waiting = wake.wait(observed, 1_000, new AbortController().signal).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(true);
    await waiting;
  });

  it("wakes an already-waiting scan and supports cancellation", async () => {
    const wake = new PostgresQueueWake();
    const controller = new AbortController();
    const waiting = wake.wait(wake.generation, 1_000, controller.signal);
    wake.notify();
    await expect(waiting).resolves.toBeUndefined();

    const cancelled = wake.wait(wake.generation, 1_000, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toBeUndefined();
  });
});

it("unlimited family capacity still enforces one writer work item per Session", () => {
  const active = Array.from({ length: 40 }, (_, n) => ({
    tenantId: "tenant",
    piSessionId: `family-${n}`,
    runId: `run-${n}`,
  }));
  const blockedFamilyKeys = active.map((r) => `tenant:${r.piSessionId}`);
  expect(familyAdmission(active, null, true, 2)).toEqual({ blockedFamilyKeys });
  expect(familyAdmission(active, null, false, 2)).toEqual({
    allowedFamilyKeys: [],
    blockedFamilyKeys,
  });
});
