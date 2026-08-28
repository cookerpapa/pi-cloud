import { describe, expect, it } from "vitest";
import {
  PostgresQueueWake,
  canPrioritizeLocalSubagent,
  selectPiWorkerExecutionReferences,
} from "../src/postgres-pi-worker.ts";

describe("PostgreSQL Pi Worker admission", () => {
  it("reserves one multi-slot Worker lane for durable Subagent children", () => {
    const parents = [1, 2, 3, 4].map((index) => ({
      commandId: `parent-${index}`,
      subagent: false,
    }));
    expect(selectPiWorkerExecutionReferences(parents, [], 4)).toEqual(parents.slice(0, 3));
    expect(
      selectPiWorkerExecutionReferences(
        [{ commandId: "child-1", subagent: true }, ...parents],
        parents.slice(0, 3),
        4,
      ),
    ).toEqual([{ commandId: "child-1", subagent: true }]);
  });

  it("uses the full pool when children are already running and keeps single-slot mode valid", () => {
    expect(
      selectPiWorkerExecutionReferences(
        [{ commandId: "parent", subagent: false }],
        [{ commandId: "child", subagent: true }],
        2,
      ),
    ).toEqual([{ commandId: "parent", subagent: false }]);
    expect(
      selectPiWorkerExecutionReferences([{ commandId: "parent", subagent: false }], [], 1),
    ).toEqual([{ commandId: "parent", subagent: false }]);
  });

  it("offers local Child work only while this Worker has immediate capacity", () => {
    expect(canPrioritizeLocalSubagent("child", [{ commandId: "parent", subagent: false }], 2)).toBe(
      true,
    );
    expect(
      canPrioritizeLocalSubagent(
        "child",
        [
          { commandId: "parent", subagent: false },
          { commandId: "other-child", subagent: true },
        ],
        2,
      ),
    ).toBe(false);
    expect(canPrioritizeLocalSubagent("child", [{ commandId: "child", subagent: true }], 2)).toBe(
      false,
    );
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
