import type { PiCloudEvent } from "@pi-cloud/protocol";
import type { AcceptedFact } from "./accepted-fact.ts";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { SessionEventHub } from "./session-event-hub.ts";

type SessionTailState = {
  canonicalThroughSequence: number;
  events: PiCloudEvent[];
  eventIds: Set<string>;
  bytes: number;
  updatedAt: number;
};

export type LiveSessionTailSnapshot = Readonly<{
  canonicalThroughSequence: number;
  highWaterMark: number;
  events: readonly PiCloudEvent[];
}>;

function stateKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\0${sessionId}`;
}

export class KafkaLiveSessionTail {
  readonly eventHub = new SessionEventHub();
  readonly #consumer: KafkaAcceptedFactConsumer;
  readonly #sessions = new Map<string, SessionTailState>();
  readonly #maximumIdleMs: number;
  #sweepTimer: NodeJS.Timeout | undefined;
  #acceptedEvents = 0;
  #duplicateEvents = 0;
  #evictedEvents = 0;

  constructor(options: {
    brokers: readonly string[];
    topic: string;
    clientId: string;
    instanceId: string;
    maximumIdleMs?: number;
  }) {
    this.#maximumIdleMs = options.maximumIdleMs ?? 30 * 60_000;
    this.#consumer = new KafkaAcceptedFactConsumer({
      brokers: options.brokers,
      clientId: `${options.clientId}-live-tail`,
      groupId: `pi-cloud-live-tail-${options.instanceId}`,
      topic: options.topic,
      mode: "earliest",
      handler: async ({ fact }) => {
        this.project(fact);
      },
    });
  }

  async start(): Promise<void> {
    this.#sweepTimer = setInterval(() => this.#sweep(), 60_000);
    this.#sweepTimer.unref();
    await this.#consumer.start();
    await this.#consumer.waitUntilCaughtUp();
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    this.eventHub.onApplicationShutdown();
    await this.#consumer.close();
    this.#sessions.clear();
  }

  #sweep(): void {
    const expiresBefore = Date.now() - this.#maximumIdleMs;
    for (const [key, state] of this.#sessions) {
      if (state.updatedAt < expiresBefore) this.#sessions.delete(key);
    }
  }

  snapshot(tenantId: string, sessionId: string): LiveSessionTailSnapshot {
    const state = this.#sessions.get(stateKey(tenantId, sessionId));
    if (state === undefined) {
      return { canonicalThroughSequence: 0, highWaterMark: 0, events: [] };
    }
    return {
      canonicalThroughSequence: state.canonicalThroughSequence,
      highWaterMark: state.events.at(-1)?.seq ?? state.canonicalThroughSequence,
      events: [...state.events],
    };
  }

  readTurn(tenantId: string, sessionId: string, turnId: string): readonly PiCloudEvent[] {
    return this.snapshot(tenantId, sessionId).events.filter((event) => event.turnId === turnId);
  }

  project(fact: AcceptedFact): void {
    if (fact.kind !== "agent_event" && fact.kind !== "terminal_event") return;
    this.#accept(fact.scope.tenantId, fact.event);
  }

  statistics() {
    return {
      activeSessionTails: this.#sessions.size,
      cachedEvents: [...this.#sessions.values()].reduce(
        (total, state) => total + state.events.length,
        0,
      ),
      cachedBytes: [...this.#sessions.values()].reduce((total, state) => total + state.bytes, 0),
      acceptedEvents: this.#acceptedEvents,
      duplicateEvents: this.#duplicateEvents,
      evictedEvents: this.#evictedEvents,
    } as const;
  }

  #accept(tenantId: string, event: PiCloudEvent): void {
    const key = stateKey(tenantId, event.sessionId);
    const state =
      this.#sessions.get(key) ??
      ({
        canonicalThroughSequence: 0,
        events: [],
        eventIds: new Set<string>(),
        bytes: 0,
        updatedAt: Date.now(),
      } satisfies SessionTailState);
    this.#sessions.set(key, state);
    if (event.seq <= state.canonicalThroughSequence || state.eventIds.has(event.eventId)) {
      this.#duplicateEvents += 1;
      return;
    }
    const sameSequence = state.events.find((candidate) => candidate.seq === event.seq);
    if (sameSequence !== undefined) {
      if (sameSequence.eventId === event.eventId) {
        this.#duplicateEvents += 1;
        return;
      }
      throw new Error("Kafka Session tail contains conflicting events at one sequence");
    }
    state.events.push(event);
    state.events.sort((left, right) => left.seq - right.seq);
    state.eventIds.add(event.eventId);
    state.bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    state.updatedAt = Date.now();
    this.#acceptedEvents += 1;

    // Existing subscribers own their queued event reference before the shared
    // Session index is advanced. No network operation runs inside this critical section.
    this.eventHub.publish(tenantId, event);
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      const retained = state.events.filter((candidate) => candidate.seq > event.seq);
      this.#evictedEvents += state.events.length - retained.length;
      state.canonicalThroughSequence = event.seq;
      state.events = retained;
      state.eventIds = new Set(retained.map((candidate) => candidate.eventId));
      state.bytes = retained.reduce(
        (total, candidate) => total + Buffer.byteLength(JSON.stringify(candidate), "utf8"),
        0,
      );
    }
  }
}
