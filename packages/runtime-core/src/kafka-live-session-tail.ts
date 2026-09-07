import type { PiCloudEvent } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { AcceptedFact } from "./accepted-fact.ts";
import {
  KafkaAcceptedFactConsumer,
  type KafkaAcceptedFactRecord,
} from "./kafka-accepted-fact-consumer.ts";
import { SessionEventHub } from "./session-event-hub.ts";
import { loadFactReplayOffsets } from "./accepted-fact-recovery.ts";
import { kafkaProducerLane } from "./kafka-accepted-fact.ts";
import {
  ExecutionStreamBoundary,
  factEvents,
  readProjectedSeal,
} from "./execution-stream-projection.ts";

type SessionTailState = {
  canonicalThroughSequence: number;
  events: PiCloudEvent[];
  eventIds: Set<string>;
  sequences: Map<number, PiCloudEvent>;
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
  readonly #database: Kysely<Database>;
  readonly #boundary: ExecutionStreamBoundary;
  readonly #sessions = new Map<string, SessionTailState>();
  readonly #maximumIdleMs: number;
  #partitions = 0;
  #sweepTimer: NodeJS.Timeout | undefined;
  #acceptedEvents = 0;
  #duplicateEvents = 0;
  #evictedEvents = 0;

  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
    instanceId: string;
    maximumIdleMs?: number;
    retentionMs?: number;
  }) {
    this.#maximumIdleMs = options.maximumIdleMs ?? 30 * 60_000;
    this.#database = options.database;
    this.#boundary = new ExecutionStreamBoundary(options.database);
    this.#consumer = new KafkaAcceptedFactConsumer({
      brokers: options.brokers,
      clientId: `${options.clientId}-live-tail`,
      groupId: `pi-cloud-live-tail-${options.instanceId}`,
      topic: options.topic,
      commitMessages: false,
      demandDriven: true,
      onReset: () => {
        this.#boundary.reset();
        this.#sessions.clear();
        this.eventHub.resyncAll();
      },
      onPartitionReset: (partition) => {
        this.#boundary.resetPartition(partition);
        for (const [key] of this.#sessions) {
          const sessionId = key.split("\0")[1]!;
          if (kafkaProducerLane(sessionId, this.#partitions) === partition)
            this.#sessions.delete(key);
        }
      },
      replayOffsets: (bounds, partitionCount) =>
        loadFactReplayOffsets(options.database, options.topic, bounds, {
          partitionCount,
          retentionMs: options.retentionMs ?? 7_200_000,
        }),
      handler: (record) => this.projectRecord(record),
    });
  }

  async start(): Promise<void> {
    this.#sweepTimer = setInterval(() => this.#sweep(), 60_000);
    this.#sweepTimer.unref();
    this.#partitions = await this.#consumer.partitionCount();
    await this.#consumer.start();
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  async retainSession(_tenantId: string, sessionId: string): Promise<() => void> {
    return this.#consumer.retainPartition(kafkaProducerLane(sessionId, this.#partitions));
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
      if (state.events.length === 0 && state.updatedAt < expiresBefore) this.#sessions.delete(key);
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
    for (const event of factEvents(fact)) this.#accept(fact.scope.tenantId, event);
  }

  async projectRecord(record: KafkaAcceptedFactRecord): Promise<void> {
    const { fact } = record;
    if (fact.kind === "execution_seal") {
      const terminal = await readProjectedSeal(this.#database, fact);
      this.#boundary.close(fact.scope.attemptId, record.offset, record.partition);
      if (terminal) this.#accept(fact.scope.tenantId, terminal);
    } else if (await this.#boundary.isOpen(record, false)) {
      this.project(fact);
    }
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
        sequences: new Map<number, PiCloudEvent>(),
        bytes: 0,
        updatedAt: Date.now(),
      } satisfies SessionTailState);
    this.#sessions.set(key, state);
    if (event.seq <= state.canonicalThroughSequence || state.eventIds.has(event.eventId)) {
      this.#duplicateEvents += 1;
      return;
    }
    const sameSequence = state.sequences.get(event.seq);
    if (sameSequence !== undefined) {
      if (sameSequence.eventId === event.eventId) {
        this.#duplicateEvents += 1;
        return;
      }
      throw new Error("Kafka Session tail contains conflicting events at one sequence");
    }
    if (state.events.length === 0 || state.events.at(-1)!.seq < event.seq) {
      state.events.push(event);
    } else {
      let low = 0,
        high = state.events.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (state.events[mid]!.seq < event.seq) low = mid + 1;
        else high = mid;
      }
      state.events.splice(low, 0, event);
    }
    state.sequences.set(event.seq, event);
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
      state.sequences = new Map(retained.map((candidate) => [candidate.seq, candidate]));
      state.eventIds = new Set(retained.map((candidate) => candidate.eventId));
      state.bytes = retained.reduce(
        (total, candidate) => total + Buffer.byteLength(JSON.stringify(candidate), "utf8"),
        0,
      );
    }
  }
}
