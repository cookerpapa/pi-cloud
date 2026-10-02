import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { RUN_OBSERVATION_STALE_MS, type RunObservation, type RunPhase } from "@pi-cloud/protocol";
import type { TurnView } from "./session-view.ts";
import { useI18n } from "./i18n.tsx";

type Observations = {
  activity?: Extract<RunObservation, { type: "run.activity" }>;
  path?: Extract<RunObservation, { type: "run.path" }>;
  execution?: Extract<RunObservation, { type: "run.execution" }>;
  toolActivityAt?: number;
};
/** Health is disposable UI state, separate from transcript/history. */
export class RunObservationStore {
  readonly #values = new Map<string, Observations>();
  readonly #listeners = new Map<string, Set<() => void>>();
  get(turnId: string): Observations | undefined {
    return this.#values.get(turnId);
  }
  subscribe(turnId: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(turnId);
    if (!listeners) this.#listeners.set(turnId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.#listeners.delete(turnId);
        this.#values.delete(turnId);
      }
    };
  }
  receive(value: RunObservation): void {
    const listeners = this.#listeners.get(value.turnId);
    if (!listeners) return;
    const previous = this.#values.get(value.turnId);
    const knownRun =
      previous?.activity?.runId ?? previous?.path?.runId ?? previous?.execution?.runId;
    if (knownRun && knownRun !== value.runId) return;
    if (value.type === "run.activity") {
      if (previous?.activity && previous.activity.revision >= value.revision) return;
      this.#values.set(value.turnId, { ...previous, activity: value });
    } else if (value.type === "run.execution") {
      if (previous?.execution && previous.execution.revision >= value.revision) return;
      this.#values.set(value.turnId, { ...previous, execution: value });
    } else {
      if (previous?.path && previous.path.sentAt >= value.sentAt) return;
      this.#values.set(value.turnId, { ...previous, path: value });
    }
    for (const listener of listeners) listener();
  }
  toolProgress(turnId: string): void {
    const listeners = this.#listeners.get(turnId);
    if (!listeners) return;
    this.#values.set(turnId, { ...this.#values.get(turnId), toolActivityAt: Date.now() });
    for (const listener of listeners) listener();
  }
  reset(): void {
    this.#values.clear();
    for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
  }
}

export function runStatus(
  turn: TurnView,
  observations: Observations | undefined,
  now: number,
  observingSince = now,
) {
  const belongs = (value: RunObservation | undefined) =>
    value && (!turn.runId || turn.runId === value.runId);
  const activity = belongs(observations?.activity) ? observations?.activity : undefined;
  const path = belongs(observations?.path) ? observations?.path : undefined;
  const execution = belongs(observations?.execution)
    ? observations?.execution?.execution
    : undefined;
  let phase: RunPhase | "queued" | "working" = turn.status === "queued" ? "queued" : "working";
  if (activity && now - activity.observedAt <= RUN_OBSERVATION_STALE_MS) phase = activity.phase;
  if (turn.status === "cancelling") phase = "cancelling";
  const seconds = (at: number) => Math.max(0, Math.floor((now - at) / 1000));
  const lastActivityAt = Math.max(activity?.lastActivityAt ?? 0, observations?.toolActivityAt ?? 0);
  return {
    phase,
    activitySeconds: lastActivityAt ? seconds(lastActivityAt) : undefined,
    pathSeconds: path ? seconds(path.sentAt) : undefined,
    executionState:
      execution?.status === "not_applicable"
        ? ("not_applicable" as const)
        : execution?.confirmedAt && now - execution.confirmedAt <= RUN_OBSERVATION_STALE_MS
          ? ("confirmed" as const)
          : execution
            ? ("unconfirmed" as const)
            : undefined,
    executionSeconds: execution?.confirmedAt ? seconds(execution.confirmedAt) : undefined,
    executionStage: execution?.stage,
    delayed:
      turn.status !== "queued" &&
      (path
        ? now - path.sentAt > RUN_OBSERVATION_STALE_MS
        : now - observingSince > RUN_OBSERVATION_STALE_MS),
  };
}

export function RunStatus({
  turn,
  store,
  connected,
}: {
  turn: TurnView;
  store: RunObservationStore | undefined;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const [observingSince, setObservingSince] = useState(Date.now);
  const queued = turn.status === "queued";
  useEffect(() => {
    // A new connection or newly started queued turn begins with unknown evidence.
    setObservingSince(Date.now());
  }, [connected, queued]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(turn.turnId, listener) ?? (() => {}),
    [store, turn.turnId],
  );
  const observations = useSyncExternalStore(
    subscribe,
    () => store?.get(turn.turnId),
    () => undefined,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const status = runStatus(turn, observations, now, observingSince);
  return (
    <div className="product-run-status" data-run-phase={status.phase}>
      <div role="status">
        <span className="product-tool-preparing-spinner" aria-hidden="true" />
        <span>{t(`run.phase.${status.phase}`)}</span>
      </div>
      {turn.status !== "queued" ? (
        <small>
          {!connected
            ? t("run.disconnected")
            : status.delayed
              ? t("run.delayed")
              : status.pathSeconds === undefined
                ? t("run.awaitingPath")
                : t("run.pathAge", { seconds: status.pathSeconds })}
          {status.activitySeconds === undefined
            ? null
            : ` · ${t("run.activityAge", { seconds: status.activitySeconds })}`}
          {status.executionState === "confirmed"
            ? ` · ${t("run.executionAge", { seconds: status.executionSeconds ?? 0 })}`
            : status.executionState === "unconfirmed"
              ? ` · ${t("run.executionUnconfirmed")}`
              : null}
        </small>
      ) : null}
    </div>
  );
}
