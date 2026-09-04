import { describe, expect, it } from "vitest";
import {
  PostgresQueueWake,
  canScheduleOwnedSubagent,
  selectPiWorkerSlotKinds,
} from "../src/postgres-pi-worker.ts";

describe("PostgreSQL Pi Worker admission", () => {
  it("reserves the declared Lane capacity for owner-local Subagent children", () => {
    const parents = [{ runId: "parent-1", subagent: false }];
    expect(selectPiWorkerSlotKinds([], 4, 3)).toEqual([false, true, true, true]);
    expect(selectPiWorkerSlotKinds(parents, 4, 3)).toEqual([true, true, true]);
  });

  it("bounds conversation and Child lanes independently", () => {
    const active = [1, 2, 3].map((index) => ({
      runId: `parent-${index}`,
      subagent: false,
    }));
    expect(selectPiWorkerSlotKinds(active, 6, 3)).toEqual([true, true, true]);
    expect(() => selectPiWorkerSlotKinds([], 3, 3)).toThrow("leave at least one conversation slot");
  });

  it("admits an owned Child only while this Worker has Child capacity", () => {
    expect(canScheduleOwnedSubagent("child", [{ runId: "parent", subagent: false }], 1)).toBe(true);
    expect(
      canScheduleOwnedSubagent(
        "child",
        [
          { runId: "parent", subagent: false },
          { runId: "other-child", subagent: true },
        ],
        1,
      ),
    ).toBe(false);
    expect(canScheduleOwnedSubagent("child", [{ runId: "child", subagent: true }], 1)).toBe(false);
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
