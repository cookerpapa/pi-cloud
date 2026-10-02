import { expect, it, vi } from "vitest";
import { RunObservationStore, runStatus } from "../src/RunStatus.tsx";
import type { TurnView } from "../src/session-view.ts";

it("keeps activity and path freshness separate across silence, cancellation and reconnect", () => {
  const store = new RunObservationStore(),
    changed = vi.fn();
  const stop = store.subscribe("turn", changed);
  const activity = {
    type: "run.activity" as const,
    sessionId: "s",
    turnId: "turn",
    runId: "run",
    revision: 1,
    phase: "waiting_model" as const,
    observedAt: 100_000,
    lastActivityAt: 80_000,
  };
  const turn = {
    runId: "run",
    turnId: "turn",
    status: "running",
    acceptedAt: new Date(50_000).toISOString(),
    items: [],
  } as unknown as TurnView;
  store.receive(activity);
  store.receive({
    type: "run.path",
    sessionId: "s",
    turnId: "turn",
    runId: "run",
    sentAt: 100_000,
    observedAt: 100_002,
  });
  expect(runStatus(turn, store.get("turn"), 101_000)).toMatchObject({
    phase: "waiting_model",
    activitySeconds: 21,
    pathSeconds: 1,
    delayed: false,
  });
  expect(runStatus(turn, store.get("turn"), 150_000)).toMatchObject({
    phase: "working",
    activitySeconds: 70,
    delayed: true,
  });
  expect(runStatus({ ...turn, status: "cancelling" }, store.get("turn"), 101_000).phase).toBe(
    "cancelling",
  );
  store.receive({ ...activity, revision: 2, runId: "other" });
  store.receive(activity);
  expect(changed).toHaveBeenCalledTimes(2);
  store.reset();
  expect(store.get("turn")).toBeUndefined();
  // Reconnecting to a long-running turn starts unknown, not immediately delayed.
  expect(runStatus(turn, undefined, 200_000, 200_000).delayed).toBe(false);
  expect(runStatus(turn, undefined, 246_000, 200_000).delayed).toBe(true);
  stop();
  store.receive({ ...activity, revision: 3 });
  expect(store.get("turn")).toBeUndefined();
});

it("keeps guest freshness independent from messages and clears it on binding replacement", () => {
  const store = new RunObservationStore();
  const stop = store.subscribe("turn", () => {});
  const turn = {
    runId: "run",
    turnId: "turn",
    status: "running",
    items: [],
  } as unknown as TurnView;
  const scope = { sessionId: "s", turnId: "turn", runId: "run" };
  store.receive({
    ...scope,
    type: "run.execution",
    revision: 1,
    observedAt: 100000,
    execution: { status: "not_applicable", stage: "projector", sentAt: 100000 },
  });
  expect(runStatus(turn, store.get("turn"), 100001).executionState).toBe("not_applicable");
  store.receive({
    ...scope,
    type: "run.execution",
    revision: 2,
    observedAt: 100000,
    execution: {
      status: "confirmed",
      stage: "worker",
      bindingId: "old",
      targetId: "old-vm",
      sentAt: 100000,
      confirmedAt: 100000,
    },
  });
  store.receive({ ...scope, type: "run.path", sentAt: 150000, observedAt: 150001 });
  expect(runStatus(turn, store.get("turn"), 150001)).toMatchObject({
    delayed: false,
    executionState: "unconfirmed",
  });
  store.receive({
    ...scope,
    type: "run.execution",
    revision: 3,
    observedAt: 151000,
    execution: { status: "pending", stage: "projector", bindingId: "new", sentAt: 151000 },
  });
  expect(runStatus(turn, store.get("turn"), 151001).executionSeconds).toBeUndefined();
  store.reset();
  expect(store.get("turn")).toBeUndefined();
  stop();
});
