import assert from "node:assert/strict";
import { streamSessionEvents } from "../../packages/web-ui/src/sse.ts";
import { RunObservationStore } from "../../packages/web-ui/src/run-observation-store.ts";

/** Owned acceptance only. Observe real SSE with the same store as the browser;
 * the separate browser gate checks DOM rendering. No transcript/credential logging. */
export function watchNativeRecoveryObservations({
  sessionId,
  turnId,
  runId,
  authorizationToken,
  fetchImplementation,
  until,
  streamEvents = streamSessionEvents,
}) {
  const controller = new AbortController(),
    store = new RunObservationStore(),
    seen = new Map();
  const unsubscribe = store.subscribe(turnId, () => {});
  let snapshots = 0,
    reconnecting = false,
    failure;
  const streaming = streamEvents({
    sessionId,
    authorizationToken,
    fetchImplementation,
    signal: controller.signal,
    onSnapshot() {
      snapshots++;
      store.reset();
    },
    onStatus(status) {
      if (status.phase === "reconnecting") reconnecting = true;
      if (status.phase !== "live") store.reset();
    },
    onEvent(value) {
      if (
        value.turnId === turnId &&
        ["turn.completed", "turn.failed", "turn.cancelled"].includes(value.type)
      )
        unsubscribe();
    },
    onRunObservation(value) {
      if (value.turnId !== turnId || value.runId !== runId) return;
      store.receive(value);
      const applied = store.get(turnId);
      let generation = seen.get(value.generation);
      if (!generation) seen.set(value.generation, (generation = {}));
      if (
        value.type === "run.activity" &&
        applied?.activity?.revision === value.revision &&
        applied.generation === value.generation
      )
        generation.activityRevision ??= value.revision;
      if (
        value.type === "run.execution" &&
        value.execution.status === "confirmed" &&
        applied?.execution?.revision === value.revision &&
        applied.generation === value.generation
      )
        generation.confirmedExecutionRevision ??= value.revision;
    },
  }).catch((error) => {
    failure = error;
  });
  const check = () => {
    if (failure) throw failure;
    assert(
      !reconnecting && snapshots <= 1,
      "Observation acceptance requires the original SSE connection",
    );
  };
  return {
    async beforeCrash() {
      return until(async () => {
        check();
        const activity = store.get(turnId)?.activity;
        return snapshots === 1 && activity?.generation;
      }, "Original Worker observation");
    },
    async afterRecovery(previousGeneration) {
      const recovered = await until(async () => {
        check();
        return [...seen].find(
          ([generation, value]) =>
            generation > previousGeneration &&
            value.activityRevision !== undefined &&
            value.confirmedExecutionRevision !== undefined,
        );
      }, "Recovered Worker observations on the same SSE connection");
      return {
        previousGeneration,
        recoveredGeneration: recovered[0],
        activityRevision: recovered[1].activityRevision,
        confirmedExecutionRevision: recovered[1].confirmedExecutionRevision,
        snapshots,
        sameSseConnection: true,
        browserStoreApplied: true,
      };
    },
    async close() {
      controller.abort();
      unsubscribe();
      await streaming;
    },
  };
}
