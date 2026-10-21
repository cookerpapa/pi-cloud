import {
  RUN_OBSERVATION_STALE_MS,
  type ConversationDetailResource,
  type PiCloudEvent,
  type RunObservation,
} from "@pi-cloud/protocol";

/** The authoritative transcript decides eligibility; health cannot reopen a turn. */
export class RunObservationView {
  readonly #running = new Map<
    string,
    {
      runId?: string;
      generation: number;
      revision: number;
      pathAt: number;
      executionRevision: number;
      children: Map<string, number>;
    }
  >();
  constructor(conversation: ConversationDetailResource) {
    for (const turn of conversation.turns)
      if (["running", "cancelling"].includes(turn.state))
        this.#running.set(turn.turnId, {
          runId: turn.runId,
          generation: 0,
          revision: 0,
          pathAt: 0,
          executionRevision: 0,
          children: new Map(),
        });
  }
  event(event: PiCloudEvent): void {
    if (!event.turnId) return;
    if (event.type === "turn.started" && !this.#running.has(event.turnId))
      this.#running.set(event.turnId, {
        generation: 0,
        revision: 0,
        pathAt: 0,
        executionRevision: 0,
        children: new Map(),
      });
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))
      this.#running.delete(event.turnId);
  }
  accept(value: RunObservation): boolean {
    const run = this.#running.get(value.turnId);
    const at = value.type === "run.path" ? value.sentAt : value.observedAt;
    if (
      !run ||
      (run.runId && run.runId !== value.runId) ||
      value.generation < run.generation ||
      at < Date.now() - RUN_OBSERVATION_STALE_MS ||
      at > Date.now() + 5_000
    )
      return false;
    run.runId = value.runId;
    if (value.generation > run.generation) {
      run.generation = value.generation;
      run.revision = 0;
      run.pathAt = 0;
      run.executionRevision = 0;
      run.children.clear();
    }
    if (value.type === "run.child_activity") {
      if (value.revision <= (run.children.get(value.childSessionId) ?? 0)) return false;
      run.children.set(value.childSessionId, value.revision);
    } else if (value.type === "run.path") {
      if (value.sentAt <= run.pathAt) return false;
      run.pathAt = value.sentAt;
    } else if (value.type === "run.execution") {
      if (value.revision <= run.executionRevision) return false;
      run.executionRevision = value.revision;
    } else {
      if (value.revision <= run.revision) return false;
      run.revision = value.revision;
    }
    return true;
  }
}
