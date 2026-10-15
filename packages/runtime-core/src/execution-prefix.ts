import type { PiCloudEvent } from "@pi-cloud/protocol";

/** Closure needs display progress and conflict proof, never another text tail. */
export class ExecutionPrefix {
  readonly #identities = new Map<number, string>();
  #covered = 0;
  #high = 0;

  get highWaterMark(): number {
    return Math.max(this.#high, this.#covered);
  }
  get pendingEventIds(): number {
    return this.#identities.size;
  }
  accept(event: Pick<PiCloudEvent, "seq" | "eventId">): void {
    if (event.seq <= this.#covered) return;
    const previous = this.#identities.get(event.seq);
    if (previous !== undefined) {
      if (previous !== event.eventId) throw new Error("Conflicting events in Session projection");
      return;
    }
    this.#identities.set(event.seq, event.eventId);
    this.#high = Math.max(this.#high, event.seq);
  }
  cover(through: number): void {
    this.#covered = Math.max(this.#covered, through);
    for (const seq of this.#identities.keys())
      if (seq <= this.#covered) this.#identities.delete(seq);
  }
}
