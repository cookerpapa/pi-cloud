import { describe, expect, it } from "vitest";
import { PostgresQueueWake } from "@pi-cloud/database";
import { familyAdmission } from "../src/postgres-pi-worker.ts";

describe("Session-family admission", () => {
  const task = (piSessionId: string, n: number) => ({
    runId: "task-" + n,
    tenantId: "tenant",
    piSessionId,
  });
  it("counts many same-family Lanes once", () => {
    const active = Array.from({ length: 8 }, (_, n) => task("a", n));
    expect(familyAdmission(active, 2, 33)).toEqual({ blockedFamilyKeys: [] });
    expect(familyAdmission([...active, task("b", 9)], 2, 33)).toEqual({
      allowedFamilyKeys: ["tenant:a", "tenant:b"],
      blockedFamilyKeys: [],
    });
  });
  it("bounds resident Lanes separately and stops new families at a soft memory watermark", () => {
    const active = [task("a", 1), task("a", 2)];
    expect(familyAdmission(active, 4, 2)).toEqual({ blockedFamilyKeys: ["tenant:a"] });
    expect(familyAdmission(active, 4, 33, false)).toEqual({
      allowedFamilyKeys: ["tenant:a"],
      blockedFamilyKeys: [],
    });
  });
  it("releases the family slot only after its final Lane leaves", () => {
    expect(familyAdmission([task("a", 2)], 1, 33).allowedFamilyKeys).toEqual(["tenant:a"]);
    expect(familyAdmission([], 1, 33).allowedFamilyKeys).toBeUndefined();
  });
  it("reserves possible families and Lane occupancy for uncommitted claims", () => {
    expect(familyAdmission([], 1, 33, true, 1).allowedFamilyKeys).toEqual([]);
    const active = [task("a", 1)];
    expect(familyAdmission(active, 2, 2, true, 1)).toEqual({
      allowedFamilyKeys: ["tenant:a"],
      blockedFamilyKeys: ["tenant:a"],
    });
    expect(familyAdmission(active, 2, 3, true, 1)).toEqual({
      allowedFamilyKeys: ["tenant:a"],
      blockedFamilyKeys: [],
    });
    expect(familyAdmission(active, 2, 3, true, 0).allowedFamilyKeys).toBeUndefined();
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
