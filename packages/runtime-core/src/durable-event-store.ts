import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { isDeepStrictEqual } from "node:util";
import type { SessionEventHub } from "./session-event-hub.ts";
import type { PiSessionMutationFactChannel } from "./accepted-fact.ts";

export type DurableEventStoreErrorCode =
  | "not_found"
  | "invalid_event"
  | "event_conflict"
  | "sequence_gap"
  | "stale_execution_grant"
  | "cursor_ahead"
  | "cursor_expired"
  | "event_store_invariant";

export class DurableEventStoreError extends Error {
  readonly code: DurableEventStoreErrorCode;
  readonly retryable: boolean;

  constructor(code: DurableEventStoreErrorCode, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "DurableEventStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type EventReplayWindow = {
  events: readonly PiCloudEvent[];
  highWaterMark: number;
};

export type FactChannelOpenRequest = Readonly<{
  executionGrant: string;
  sessionId: string;
  turnId: string;
  nextEventSeq: number;
}>;

export interface FactChannel extends PiSessionMutationFactChannel {
  readonly acknowledgedThroughSeq: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  close(): Promise<void>;
}

export interface FactChannelFactory {
  open(request: FactChannelOpenRequest): Promise<FactChannel>;
}

export interface DurableEventLog {
  openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<EventReplayWindow>;
  readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit?: number,
  ): Promise<readonly PiCloudEvent[]>;
}

export type DurableEventStoreOptions = Readonly<{
  eventHub?: SessionEventHub;
  database?: Kysely<Database>;
}>;

/**
 * Deterministic process-local event log for unit/development composition. The
 * maintained production path injects KafkaLiveSessionTail and never constructs
 * this class.
 */
export class DurableEventStore implements DurableEventLog, FactChannelFactory {
  readonly #events = new Map<string, PiCloudEvent[]>();
  readonly #database: Kysely<Database> | undefined;

  constructor(options: DurableEventStoreOptions = {}) {
    this.#database = options.database;
  }

  snapshot(_tenantId: string, sessionId: string) {
    const events = this.#events.get(sessionId) ?? [];
    const canonicalThroughSequence =
      [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled",
        )?.seq ?? 0;
    const liveEvents = events.filter((event) => event.seq > canonicalThroughSequence);
    return {
      canonicalThroughSequence,
      highWaterMark: liveEvents.at(-1)?.seq ?? canonicalThroughSequence,
      events: liveEvents,
    };
  }

  async open(request: FactChannelOpenRequest): Promise<FactChannel> {
    let acknowledgedThroughSeq = request.nextEventSeq - 1;
    let closed = false;
    return {
      get acknowledgedThroughSeq() {
        return acknowledgedThroughSeq;
      },
      ingest: async (value) => {
        if (closed) throw new DurableEventStoreError("invalid_event", "Event writer is closed");
        const publication = parseSupervisorToControlMessage(value);
        if (
          publication.type !== "event.publish" ||
          publication.payload.executionGrant !== request.executionGrant ||
          publication.payload.event.sessionId !== request.sessionId ||
          publication.payload.event.turnId !== request.turnId
        ) {
          throw new DurableEventStoreError(
            "invalid_event",
            "Event does not match its writer scope",
          );
        }
        this.#append(publication.payload.event);
        acknowledgedThroughSeq = publication.payload.event.seq;
        const acknowledgement = parseControlToSupervisorMessage({
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          type: "event.ack",
          payload: {
            sessionId: publication.payload.event.sessionId,
            executionGrant: publication.payload.executionGrant,
            acknowledgedThroughSeq,
          },
        });
        if (acknowledgement.type !== "event.ack") throw new Error("Invalid event ACK");
        return acknowledgement;
      },
      mutate: async () => {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "The deterministic event log cannot project Pi Session mutations",
        );
      },
      close: async () => {
        closed = true;
      },
    };
  }

  async openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<EventReplayWindow> {
    await this.#assertSession(tenantId, sessionId);
    const events = this.#events.get(sessionId) ?? [];
    const highWaterMark = events.at(-1)?.seq ?? 0;
    if (afterSequence > highWaterMark) {
      throw new DurableEventStoreError("cursor_ahead", "Replay cursor is ahead of the event log");
    }
    return {
      events: events.filter((event) => event.seq > afterSequence).slice(0, limit),
      highWaterMark,
    };
  }

  async readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit = 500,
  ): Promise<readonly PiCloudEvent[]> {
    await this.#assertSession(tenantId, sessionId);
    return (this.#events.get(sessionId) ?? [])
      .filter((event) => event.seq > afterSequence && event.seq <= throughSequence)
      .slice(0, limit);
  }

  #append(event: PiCloudEvent): void {
    const events = this.#events.get(event.sessionId) ?? [];
    const existing = events.find((candidate) => candidate.seq === event.seq);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, event)) return;
      throw new DurableEventStoreError("event_conflict", "Event sequence was reused");
    }
    const previous = events.at(-1)?.seq ?? 0;
    if (event.seq !== previous + 1) {
      throw new DurableEventStoreError("sequence_gap", "Event stream contains a sequence gap");
    }
    events.push(event);
    this.#events.set(event.sessionId, events);
  }

  async #assertSession(tenantId: string, sessionId: string): Promise<void> {
    if (this.#database === undefined) return;
    const session = await this.#database
      .selectFrom("sessions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (session === undefined)
      throw new DurableEventStoreError("not_found", "Session was not found");
  }
}
