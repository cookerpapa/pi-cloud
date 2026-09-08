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
import { ExecutionStreamBoundary, factEvents } from "./execution-stream-projection.ts";

type PendingDisplayItem = { sealId?: string; event?: PiCloudEvent; bytes: number };
type PendingDisplay = {
  items: PendingDisplayItem[];
  seals: Map<string, PendingDisplayItem>;
  bytes: number;
};
const MAXIMUM_PENDING_SESSION_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PENDING_DISPLAY_BYTES = 64 * 1024 * 1024;

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
  readonly #boundary: ExecutionStreamBoundary;
  readonly #database: Kysely<Database>;
  readonly #sessionPartitions = new Map<string, number>();
  readonly #sessions = new Map<string, SessionTailState>();
  readonly #pendingDisplay = new Map<string, PendingDisplay>();
  #pendingDisplayBytes = 0;
  #pendingDisplayReplays = 0;
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
        this.#pendingDisplay.clear();
        this.#pendingDisplayBytes = 0;
        this.#sessionPartitions.clear();
        this.eventHub.resyncAll();
      },
      onPartitionReset: (partition) => {
        this.#boundary.resetPartition(partition);
        for (const [key] of this.#sessions) {
          if (this.#sessionPartitions.get(key) === partition) this.#sessions.delete(key);
        }
        for (const [key] of this.#pendingDisplay) {
          if (this.#sessionPartitions.get(key) === partition) this.#discardPending(key);
        }
        for (const [key, p] of this.#sessionPartitions)
          if (p === partition) this.#sessionPartitions.delete(key);
      },
      replayOffsets: (bounds) => loadFactReplayOffsets(options.database, options.topic, bounds),
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

  async retainSession(tenantId: string, sessionId: string): Promise<() => void> {
    const session = await this.#database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return this.#consumer.retainPartition(
      kafkaProducerLane(session.pi_session_id, this.#partitions),
    );
  }

  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    this.eventHub.onApplicationShutdown();
    await this.#consumer.close();
    this.#sessions.clear();
    this.#pendingDisplay.clear();
    this.#pendingDisplayBytes = 0;
    this.#sessionPartitions.clear();
  }

  #sweep(): void {
    const expiresBefore = Date.now() - this.#maximumIdleMs;
    for (const [key, state] of this.#sessions) {
      if (state.events.length === 0 && state.updatedAt < expiresBefore) this.#sessions.delete(key);
    }
    for (const key of this.#sessionPartitions.keys())
      if (!this.#sessions.has(key) && !this.#pendingDisplay.has(key))
        this.#sessionPartitions.delete(key);
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
    for (const event of factEvents(fact)) {
      const key = stateKey(fact.scope.tenantId, event.sessionId);
      if (this.#pendingDisplay.has(key)) {
        if (!this.#defer(key, { event, bytes: Buffer.byteLength(JSON.stringify(event), "utf8") }))
          return;
      } else this.#accept(fact.scope.tenantId, event);
    }
  }

  async projectRecord(record: KafkaAcceptedFactRecord): Promise<void> {
    const { fact } = record;
    this.#sessionPartitions.set(
      stateKey(fact.scope.tenantId, fact.scope.sessionId),
      record.partition,
    );
    if (fact.kind === "execution_seal") {
      this.#boundary.close(fact.scope.attemptId, record.offset, record.partition);
      if (fact.closesWriter)
        this.#boundary.closeWriter(fact.scope.writerId, record.offset, record.partition);
      const key = stateKey(fact.scope.tenantId, fact.scope.sessionId);
      if ((this.#sessions.get(key)?.canonicalThroughSequence ?? 0) > fact.baseSequence) return;
      if (this.#pendingDisplay.get(key)?.seals.has(fact.factId)) return;
      this.#defer(key, { sealId: fact.factId, bytes: 128 });
    } else if (fact.kind === "execution_committed") {
      this.#boundary.close(fact.scope.attemptId, BigInt(fact.seal.offset), fact.seal.partition);
      const key = stateKey(fact.scope.tenantId, fact.scope.sessionId);
      const pending = this.#pendingDisplay.get(key);
      const slot = pending?.seals.get(fact.seal.factId);
      if (!slot) {
        // Recovery may begin after the original seal. The notification is
        // self-contained and old terminal sequences are idempotently ignored.
        this.#accept(fact.scope.tenantId, fact.event);
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(fact.event), "utf8");
      const increase = bytes - slot.bytes;
      if (!this.#reserveDisplay(pending!, increase)) return;
      pending!.bytes += increase;
      this.#pendingDisplayBytes += increase;
      slot.bytes = bytes;
      slot.event = fact.event;
      let consumed = 0;
      for (const item of pending!.items) {
        if (!item.event) break;
        this.#accept(fact.scope.tenantId, item.event);
        if (item.sealId) pending!.seals.delete(item.sealId);
        pending!.bytes -= item.bytes;
        this.#pendingDisplayBytes -= item.bytes;
        consumed++;
      }
      pending!.items.splice(0, consumed);
      if (!pending!.items.length) this.#pendingDisplay.delete(key);
    } else if (await this.#boundary.isOpen(record, false)) {
      this.project(fact);
    }
  }

  #discardPending(key: string): void {
    this.#pendingDisplayBytes -= this.#pendingDisplay.get(key)?.bytes ?? 0;
    this.#pendingDisplay.delete(key);
  }

  #reserveDisplay(pending: PendingDisplay, bytes: number): boolean {
    if (
      pending.bytes + bytes > MAXIMUM_PENDING_SESSION_BYTES ||
      this.#pendingDisplayBytes + bytes > MAXIMUM_PENDING_DISPLAY_BYTES
    ) {
      // Never pause at the missing ACK: it is later in this same partition.
      // Drop bounded soft state, resnapshot clients and seek durable PG floors.
      this.#pendingDisplayReplays++;
      this.#pendingDisplay.clear();
      this.#pendingDisplayBytes = 0;
      this.#sessions.clear();
      this.#boundary.reset();
      this.eventHub.resyncAll();
      this.#consumer.requestReplay();
      return false;
    }
    return true;
  }

  #defer(key: string, item: PendingDisplayItem): boolean {
    const pending: PendingDisplay = this.#pendingDisplay.get(key) ?? {
      items: [],
      seals: new Map(),
      bytes: 0,
    };
    if (!this.#reserveDisplay(pending, item.bytes)) return false;
    pending.items.push(item);
    if (item.sealId) pending.seals.set(item.sealId, item);
    pending.bytes += item.bytes;
    this.#pendingDisplayBytes += item.bytes;
    this.#pendingDisplay.set(key, pending);
    return true;
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
      pendingCommitSessions: this.#pendingDisplay.size,
      pendingCommitBytes: this.#pendingDisplayBytes,
      pendingCommitReplays: this.#pendingDisplayReplays,
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
