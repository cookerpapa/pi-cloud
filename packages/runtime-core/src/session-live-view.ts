import type { PiCloudEvent } from "@pi-cloud/protocol";
import { SessionEventHub } from "./session-event-hub.ts";
export type LiveSessionTailSnapshot = Readonly<{
  canonicalThroughSequence: number;
  highWaterMark: number;
  events: readonly PiCloudEvent[];
}>;

type Tail = {
  through: number;
  events: PiCloudEvent[];
  ids: Set<string>;
  sequences: Map<number, string>;
  bytes: number;
  touched: number;
};
const key = (tenant: string, session: string) => `${tenant}\0${session}`;

/** A disposable projection fed by the ONE partition consumer. It never reads Kafka. */
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
        if (!t.events.length && t.touched < Date.now() - 300000) this.#tails.delete(id);
    }, 60000);
    this.#sweep.unref();
  }
  reset(): void {
    this.#tails.clear();
    this.eventHub.resyncAll();
  }
  snapshot(tenant: string, session: string): LiveSessionTailSnapshot {
    const t = this.#tails.get(key(tenant, session));
    return {
      canonicalThroughSequence: t?.through ?? 0,
      highWaterMark: t?.events.at(-1)?.seq ?? t?.through ?? 0,
      events: [...(t?.events ?? [])],
    };
  }
  accept(tenant: string, event: PiCloudEvent): void {
    const id = key(tenant, event.sessionId);
    const t: Tail = this.#tails.get(id) ?? {
      through: 0,
      events: [],
      ids: new Set(),
      sequences: new Map(),
      bytes: 0,
      touched: Date.now(),
    };
    t.touched = Date.now();
    this.#tails.set(id, t);
    if (event.seq <= t.through || t.ids.has(event.eventId)) {
      this.#duplicates++;
      return;
    }
    if (t.sequences.has(event.seq)) throw new Error("Conflicting events in Session projection");
    if (t.events.length === 0 || t.events.at(-1)!.seq < event.seq) t.events.push(event);
    else {
      let low = 0,
        high = t.events.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (t.events[mid]!.seq < event.seq) low = mid + 1;
        else high = mid;
      }
      t.events.splice(low, 0, event);
    }
    t.ids.add(event.eventId);
    t.sequences.set(event.seq, event.eventId);
    t.bytes += Buffer.byteLength(JSON.stringify(event));
    this.#accepted++;
    this.eventHub.publish(tenant, event);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      this.#evicted += t.events.length;
      t.through = event.seq;
      t.events = [];
      t.ids.clear();
      t.sequences.clear();
      t.bytes = 0;
    }
  }
  readTurn(tenant: string, session: string, turn: string) {
    return this.snapshot(tenant, session).events.filter((e) => e.turnId === turn);
  }
  statistics() {
    return {
      activeSessionTails: this.#tails.size,
      cachedEvents: [...this.#tails.values()].reduce((n, t) => n + t.events.length, 0),
      cachedBytes: [...this.#tails.values()].reduce((n, t) => n + t.bytes, 0),
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
