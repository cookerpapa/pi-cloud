import type { PiCloudEvent } from "@pi-cloud/protocol";
import { SessionEventHub } from "./session-event-hub.ts";
import { CompactEventTail } from "./compact-event-tail.ts";

export type LiveSessionTailSnapshot = Readonly<{
  canonicalThroughSequence: number;
  highWaterMark: number;
  /** Internal presentation spans, not original Kafka records. */
  events: readonly PiCloudEvent[];
}>;
type Tail = { content: CompactEventTail; touched: number };
const key = (tenant: string, session: string) => `${tenant}\0${session}`;

/** The single consumer feeds live delivery and a compact, disposable view. */
export class SessionLiveView {
  owner?: (tenant: string, session: string) => Promise<string | undefined>;
  readonly eventHub = new SessionEventHub();
  readonly #tails = new Map<string, Tail>();
  #accepted = 0;
  #duplicates = 0;
  #evicted = 0;
  readonly #sweep: NodeJS.Timeout;
  constructor(readonly retainSession: (tenant: string, session: string) => Promise<() => void>) {
    this.#sweep = setInterval(() => {
      for (const [id, t] of this.#tails)
        if (!t.content.size && t.touched < Date.now() - 300000) this.#tails.delete(id);
    }, 60000);
    this.#sweep.unref();
  }
  reset(): void {
    this.#tails.clear();
    this.eventHub.resyncAll();
  }
  snapshot(tenant: string, session: string): LiveSessionTailSnapshot {
    const content = this.#tails.get(key(tenant, session))?.content;
    return {
      canonicalThroughSequence: content?.coveredThrough ?? 0,
      highWaterMark: content?.highWaterMark ?? 0,
      events: content?.events ?? [],
    };
  }
  #tail(tenant: string, session: string) {
    const id = key(tenant, session);
    let t = this.#tails.get(id);
    if (!t) {
      t = { content: new CompactEventTail(), touched: Date.now() };
      this.#tails.set(id, t);
    }
    t.touched = Date.now();
    return t.content;
  }
  accept(tenant: string, event: PiCloudEvent): void {
    const content = this.#tail(tenant, event.sessionId);
    if (!content.accept(event)) {
      this.#duplicates++;
      return;
    }
    this.#accepted++;
    // Normal subscribers receive each original event immediately, not its span.
    this.eventHub.publish(tenant, event);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))
      this.cover(tenant, event.sessionId, event.seq);
  }
  cover(tenant: string, session: string, through: number): void {
    const content = this.#tail(tenant, session),
      before = content.size;
    content.cover(through);
    this.#evicted += before - content.size;
  }
  readTurn(tenant: string, session: string, turn: string) {
    return this.snapshot(tenant, session).events.filter((e) => e.turnId === turn);
  }
  statistics() {
    return {
      activeSessionTails: this.#tails.size,
      cachedEvents: [...this.#tails.values()].reduce((n, t) => n + t.content.size, 0),
      cachedBytes: [...this.#tails.values()].reduce((n, t) => n + t.content.bytes, 0),
      acceptedEvents: this.#accepted,
      duplicateEvents: this.#duplicates,
      evictedEvents: this.#evicted,
    };
  }
  close(): void {
    clearInterval(this.#sweep);
    this.reset();
    this.eventHub.onApplicationShutdown();
  }
}
