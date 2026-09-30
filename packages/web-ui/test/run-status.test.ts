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
  stop();
  store.receive({ ...activity, revision: 3 });
  expect(store.get("turn")).toBeUndefined();
});
