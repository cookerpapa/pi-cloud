import type { RunObservation } from "@pi-cloud/protocol";

export type Observations = {
  generation?: number;
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
    const generation = previous?.generation ?? 0;
    if (value.generation < generation) return;
    // Replace the whole bundle: a new path must not retain an old VM or Tool age.
    const current: Observations | undefined =
      value.generation > generation ? { generation: value.generation } : previous;
    if (value.type === "run.activity") {
      if (current?.activity && current.activity.revision >= value.revision) return;
      this.#values.set(value.turnId, { ...current, activity: value });
    } else if (value.type === "run.execution") {
      if (current?.execution && current.execution.revision >= value.revision) return;
      this.#values.set(value.turnId, { ...current, execution: value });
    } else {
      if (current?.path && current.path.sentAt >= value.sentAt) return;
      this.#values.set(value.turnId, { ...current, path: value });
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
