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
    { runId?: string; revision: number; pathAt: number; executionRevision: number }
  >();
  constructor(conversation: ConversationDetailResource) {
    for (const turn of conversation.turns)
      if (["running", "cancelling"].includes(turn.state))
        this.#running.set(turn.turnId, {
          runId: turn.runId,
          revision: 0,
          pathAt: 0,
          executionRevision: 0,
        });
  }
  event(event: PiCloudEvent): void {
    if (!event.turnId) return;
    if (event.type === "turn.started" && !this.#running.has(event.turnId))
      this.#running.set(event.turnId, { revision: 0, pathAt: 0, executionRevision: 0 });
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))
      this.#running.delete(event.turnId);
  }
  accept(value: RunObservation): boolean {
    const run = this.#running.get(value.turnId);
    const at = value.type === "run.path" ? value.sentAt : value.observedAt;
    if (
      !run ||
      (run.runId && run.runId !== value.runId) ||
      at < Date.now() - RUN_OBSERVATION_STALE_MS ||
      at > Date.now() + 5_000
    )
      return false;
    run.runId = value.runId;
    if (value.type === "run.path") {
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
