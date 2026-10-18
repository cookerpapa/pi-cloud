import { expect, it } from "vitest";
import { watchNativeRecoveryObservations } from "./live-native-observations.mjs";

function fixture() {
  let options;
  const watcher = watchNativeRecoveryObservations({
    sessionId: "s",
    turnId: "t",
    runId: "r",
    until: async (read, label) => {
      const result = await read();
      if (!result) throw new Error(label);
      return result;
    },
    streamEvents: (value) => {
      options = value;
      return new Promise((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  options.onStatus({ phase: "connecting" });
  options.onSnapshot({});
  options.onStatus({ phase: "live" });
  const activity = (generation) =>
    options.onRunObservation({
      type: "run.activity",
      sessionId: "s",
      turnId: "t",
      runId: "r",
      generation,
      revision: 1,
      phase: "executing_tool",
      observedAt: 100,
      lastActivityAt: 100,
    });
  const execution = (generation, status) =>
    options.onRunObservation({
      type: "run.execution",
      sessionId: "s",
      turnId: "t",
      runId: "r",
      generation,
      revision: 1,
      observedAt: 100,
      execution: { status, stage: "worker", sentAt: 100, confirmedAt: 100 },
    });
  return { watcher, options, activity, execution };
}

it("requires applied newer-generation activity and confirmed execution on one snapshot", async () => {
  const f = fixture();
  try {
    f.activity(7);
    expect(await f.watcher.beforeCrash()).toBe(7);
    f.execution(7, "confirmed");
    f.activity(8);
    f.execution(8, "pending");
    await expect(f.watcher.afterRecovery(7)).rejects.toThrow("Recovered Worker observations");
    f.options.onRunObservation({
      type: "run.execution",
      sessionId: "s",
      turnId: "t",
      runId: "r",
      generation: 8,
      revision: 2,
      observedAt: 101,
      execution: { status: "confirmed", stage: "worker", sentAt: 101, confirmedAt: 101 },
    });
    f.activity(7); // the browser store must reject this late frame
    expect(await f.watcher.afterRecovery(7)).toMatchObject({
      previousGeneration: 7,
      recoveredGeneration: 8,
      snapshots: 1,
      sameSseConnection: true,
      browserStoreApplied: true,
    });
  } finally {
    await f.watcher.close();
  }
});

it("does not count reconnecting and resetting the page as same-connection recovery", async () => {
  const f = fixture();
  try {
    f.activity(7);
    f.options.onStatus({ phase: "reconnecting" });
    f.options.onSnapshot({});
    f.activity(8);
    f.execution(8, "confirmed");
    await expect(f.watcher.afterRecovery(7)).rejects.toThrow("original SSE connection");
  } finally {
    await f.watcher.close();
  }
});
