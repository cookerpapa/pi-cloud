import type { Database } from "@pi-cloud/database";
import {
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  parseControlToSupervisorMessage,
  parseLiveTurnSnapshotResource,
  parsePiCloudEvent,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type LiveTurnSnapshotResource,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import { DeliverPolicy } from "@nats-io/jetstream";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  PostgresAgentEventAuthority,
  parseAcceptedAgentEventEnvelope,
  type AcceptedAgentEventEnvelope,
} from "./agent-event-authority.ts";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import {
  DurableEventStoreError,
  type DurableEventIngestor,
  type DurableEventLog,
  type EventReplayWindow,
} from "./durable-event-store.ts";
import {
  AGENT_EVENT_STREAM_NAME,
  AGENT_LIVE_SUBJECT_PREFIX,
  agentEventSubject,
  sessionSubjectToken,
  type PiCloudJetStream,
} from "./jetstream-runtime.ts";
import type { LiveTurnSnapshotSource } from "./live-turn-snapshot.ts";
import type { SessionEventHub } from "./session-event-hub.ts";
import {
  type PrepareTerminalTurnProjectionInput,
  type PreparedTerminalTurnProjection,
  type TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

const MAXIMUM_AUTHORITY_BATCH = 256;
const AUTHORITY_BATCH_DELAY_MS = 2;
const MAXIMUM_QUEUED_EVENTS = 65_536;
type LiveSubscription = ReturnType<PiCloudJetStream["connection"]["subscribe"]>;

function encodeEnvelope(envelope: AcceptedAgentEventEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function acknowledgement(message: EventPublishMessage): EventAckMessage {
  const parsed = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.ack",
    payload: {
      sessionId: message.payload.event.sessionId,
      leaseId: message.payload.leaseId,
      fencingToken: message.payload.fencingToken,
      acknowledgedThroughSeq: message.payload.event.seq,
    },
  });
  if (parsed.type !== "event.ack") throw new Error("Agent event ACK is invalid");
  return parsed;
}

export class JetStreamAcceptedAgentEventPublisher {
  readonly #runtime: PiCloudJetStream;

  constructor(runtime: PiCloudJetStream) {
    this.#runtime = runtime;
  }

  async append(envelope: AcceptedAgentEventEnvelope): Promise<void> {
    const message = envelope.publications[0]!;
    await this.#runtime.client.publish(
      agentEventSubject(message.payload.event.sessionId),
      encodeEnvelope(envelope),
      {
        msgID: message.payload.event.eventId,
        expect: { streamName: AGENT_EVENT_STREAM_NAME },
        timeout: 10_000,
      },
    );
  }

  async appendGroup(envelopes: readonly AcceptedAgentEventEnvelope[]): Promise<void> {
    if (envelopes.length < 1 || envelopes.length > MAXIMUM_AUTHORITY_BATCH) {
      throw new TypeError("Accepted Agent event group is invalid");
    }
    await Promise.all(envelopes.map((envelope) => this.append(envelope)));
  }

  async checkHealth(): Promise<void> {
    await this.#runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME);
  }
}

export type AgentEventAuthorityPort = Pick<PostgresAgentEventAuthority, "commitAcceptedMany">;
export type AcceptedAgentEventPublisherPort = Pick<
  JetStreamAcceptedAgentEventPublisher,
  "appendGroup" | "checkHealth"
>;

type PendingIngest = {
  message: EventPublishMessage;
  resolve: (acknowledgement: EventAckMessage) => void;
  reject: (error: unknown) => void;
};

/**
 * Batches only the authority decision, never unacknowledged durability. Every
 * caller resolves after its own event has a JetStream PubAck and the Attempt
 * watermark is advanced. This removes per-delta PostgreSQL round trips without
 * weakening stale-Worker fencing.
 */
export class JetStreamAgentEventIngestor implements DurableEventIngestor {
  readonly #authority: AgentEventAuthorityPort;
  readonly #publisher: AcceptedAgentEventPublisherPort;
  #queue: PendingIngest[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #closed = false;
  #batchCount = 0;
  #eventCount = 0;
  #maximumBatchSize = 0;

  constructor(options: {
    database?: Kysely<Database>;
    publisher: AcceptedAgentEventPublisherPort;
    authority?: AgentEventAuthorityPort;
  }) {
    if (options.authority === undefined && options.database === undefined) {
      throw new TypeError("Agent event ingestor requires a database or authority port");
    }
    this.#authority =
      options.authority ?? new PostgresAgentEventAuthority({ database: options.database! });
    this.#publisher = options.publisher;
  }

  ingest(value: unknown): Promise<EventAckMessage> {
    if (this.#closed) return Promise.reject(new Error("Agent event ingestor is closed"));
    const message = parseSupervisorToControlMessage(value);
    if (message.type !== "event.publish") {
      return Promise.reject(
        new DurableEventStoreError("invalid_event", "Expected an Agent event publication"),
      );
    }
    if (this.#queue.length >= MAXIMUM_QUEUED_EVENTS) {
      return Promise.reject(
        new DurableEventStoreError(
          "event_store_invariant",
          "Agent event ingest queue is full",
          true,
        ),
      );
    }
    const result = new Promise<EventAckMessage>((resolve, reject) => {
      this.#queue.push({ message, resolve, reject });
    });
    if (this.#queue.length >= MAXIMUM_AUTHORITY_BATCH) this.#scheduleFlush(0);
    else this.#scheduleFlush(AUTHORITY_BATCH_DELAY_MS);
    return result;
  }

  async checkHealth(): Promise<void> {
    if (this.#closed) {
      throw new Error("Agent event ingestor is unhealthy");
    }
    await this.#publisher.checkHealth();
  }

  statistics(): Readonly<{ batches: number; events: number; maximumBatchSize: number }> {
    return {
      batches: this.#batchCount,
      events: this.#eventCount,
      maximumBatchSize: this.#maximumBatchSize,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#flushing !== undefined) await this.#flushing;
    else await this.#drain();
  }

  #scheduleFlush(delayMs: number): void {
    if (this.#flushing !== undefined) return;
    if (this.#timer !== undefined) {
      if (delayMs !== 0) return;
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#drain().finally(() => {
        this.#flushing = undefined;
        if (this.#queue.length > 0 && !this.#closed) this.#scheduleFlush(0);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, MAXIMUM_AUTHORITY_BATCH);
      this.#batchCount += 1;
      this.#eventCount += batch.length;
      this.#maximumBatchSize = Math.max(this.#maximumBatchSize, batch.length);
      try {
        const authority = await this.#authority.commitAcceptedMany(
          batch.map((entry) => entry.message),
          (accepted) => this.#publisher.appendGroup(accepted),
        );
        const acceptedByMessage = new Map(
          authority.accepted.map((envelope) => [envelope.publications[0]!, envelope]),
        );
        const duplicates = new Set(authority.duplicates);
        for (const entry of batch) {
          if (acceptedByMessage.has(entry.message) || duplicates.has(entry.message)) {
            entry.resolve(acknowledgement(entry.message));
          } else {
            entry.reject(
              new DurableEventStoreError(
                "stale_fence",
                "Agent event was rejected by current RunAttempt authority",
              ),
            );
          }
        }
      } catch (error: unknown) {
        for (const entry of batch) entry.reject(error);
        if (this.#closed) break;
      }
    }
  }
}

export const AGENT_EVENT_INGEST_PATH = "/internal/v1/agent-events";

export class HttpAgentEventIngestor implements DurableEventIngestor {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #allowInsecureHttp: boolean;

  constructor(options: { baseUrl: string; serviceToken: string; allowInsecureHttp: boolean }) {
    this.#url = new URL(AGENT_EVENT_INGEST_PATH, options.baseUrl);
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#allowInsecureHttp = options.allowInsecureHttp;
    if (this.#url.protocol === "http:" && !this.#allowInsecureHttp) {
      throw new TypeError("Plain HTTP Agent event ingest requires explicit opt-in");
    }
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    const message = parseSupervisorToControlMessage(value);
    if (message.type !== "event.publish") {
      throw new DurableEventStoreError("invalid_event", "Expected an Agent event publication");
    }
    const body = JSON.stringify(message);
    const deadline = Date.now() + 30_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const response = await fetch(this.#url, {
          method: "POST",
          headers: { authorization: this.#authorization, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
        });
        if (response.status === 409) {
          throw new DurableEventStoreError(
            "stale_fence",
            "Agent event was rejected by current RunAttempt authority",
          );
        }
        if (response.ok) {
          const parsed = parseControlToSupervisorMessage(await response.json());
          if (parsed.type !== "event.ack") {
            throw new DurableEventStoreError("invalid_event", "Agent event ingest ACK is invalid");
          }
          return parsed;
        }
        if (response.status < 500) break;
      } catch (error: unknown) {
        if (error instanceof DurableEventStoreError && error.code === "stale_fence") throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(remaining, Math.min(1_000, 100 * 2 ** (attempt - 1)))),
      );
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Agent event ingest service is unavailable",
      true,
    );
  }

  async checkHealth(): Promise<void> {
    const response = await fetch(new URL(`${AGENT_EVENT_INGEST_PATH}/health`, this.#url), {
      headers: { authorization: this.#authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Agent event ingest service is unavailable");
  }
}

export class JetStreamLiveEventStore implements DurableEventLog {
  readonly #database: Kysely<Database>;
  readonly #runtime: PiCloudJetStream;
  readonly #eventHub: SessionEventHub;
  #subscription: LiveSubscription | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    database: Kysely<Database>;
    runtime: PiCloudJetStream;
    eventHub: SessionEventHub;
  }) {
    this.#database = options.database;
    this.#runtime = options.runtime;
    this.#eventHub = options.eventHub;
  }

  start(): void {
    if (this.#subscription !== undefined) throw new Error("JetStream live event store is running");
    this.#subscription = this.#runtime.connection.subscribe(`${AGENT_LIVE_SUBJECT_PREFIX}.>`);
    this.#task = this.#consume(this.#subscription).catch((error: unknown) => {
      this.#failure = error;
    });
    void this.#observeStatus().catch((error: unknown) => {
      this.#failure = error;
    });
  }

  async close(): Promise<void> {
    this.#subscription?.unsubscribe();
    await this.#task;
    this.#subscription = undefined;
  }

  checkHealth(): void {
    if (this.#subscription === undefined || this.#failure !== undefined) {
      throw new Error("JetStream live event store is unhealthy");
    }
  }

  async ingest(_value: unknown): Promise<EventAckMessage> {
    throw new DurableEventStoreError(
      "event_store_invariant",
      "JetStream live event projection cannot ingest Worker events directly",
    );
  }

  async openReplayWindow(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<EventReplayWindow> {
    const canonicalThrough = await this.#canonicalThrough(tenantId, sessionId);
    const retained = await this.#readSession(sessionId);
    const highWaterMark = Math.max(canonicalThrough, retained.at(-1)?.seq ?? canonicalThrough);
    if (afterSequence < canonicalThrough) {
      throw new DurableEventStoreError(
        "cursor_expired",
        "Canonical Session state replaced this live-event cursor",
      );
    }
    if (afterSequence > highWaterMark) {
      throw new DurableEventStoreError("cursor_ahead", "Replay cursor is ahead of the event log");
    }
    const suffix = retained.filter((event) => event.seq > afterSequence);
    if (suffix.length > 0 && suffix[0]!.seq !== afterSequence + 1) {
      throw new DurableEventStoreError(
        "cursor_expired",
        "The retained JetStream window no longer contains this cursor",
      );
    }
    return { events: suffix.slice(0, limit), highWaterMark };
  }

  async readReplayPage(
    tenantId: string,
    sessionId: string,
    afterSequence: number,
    throughSequence: number,
    limit = 500,
  ): Promise<readonly PiCloudEvent[]> {
    const replay = await this.openReplayWindow(tenantId, sessionId, afterSequence, limit);
    return replay.events.filter((event) => event.seq <= throughSequence);
  }

  async readTurn(
    tenantId: string,
    sessionId: string,
    turnId: string,
  ): Promise<readonly PiCloudEvent[]> {
    await this.#canonicalThrough(tenantId, sessionId);
    return (await this.#readSession(sessionId)).filter((event) => event.turnId === turnId);
  }

  async #canonicalThrough(tenantId: string, sessionId: string): Promise<number> {
    const row = await this.#database
      .selectFrom("sessions")
      .select("next_event_seq")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) throw new DurableEventStoreError("not_found", "Session was not found");
    const next = Number(row.next_event_seq);
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Session event sequence is invalid",
      );
    }
    return next - 1;
  }

  async #readSession(sessionId: string): Promise<PiCloudEvent[]> {
    const subject = agentEventSubject(sessionId);
    const info = await this.#runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME, {
      subjects_filter: subject,
    });
    const count = info.state.subjects?.[subject] ?? 0;
    if (count === 0) return [];
    const consumer = await this.#runtime.client.consumers.get(AGENT_EVENT_STREAM_NAME, {
      name_prefix: `replay${Math.random().toString(36).slice(2, 8)}`,
      filter_subjects: subject,
      deliver_policy: DeliverPolicy.All,
      inactive_threshold: 10_000,
    });
    const messages = await consumer.fetch({ max_messages: count, expires: 10_000 });
    const events: PiCloudEvent[] = [];
    try {
      for await (const message of messages) {
        const envelope = parseAcceptedAgentEventEnvelope(message.data);
        for (const publication of envelope.publications) events.push(publication.payload.event);
      }
    } finally {
      await messages.close().catch(() => undefined);
      await consumer.delete().catch(() => undefined);
    }
    return events.sort((left, right) => left.seq - right.seq);
  }

  async #consume(subscription: LiveSubscription): Promise<void> {
    for await (const message of subscription) {
      const envelope = parseAcceptedAgentEventEnvelope(message.data);
      for (const publication of envelope.publications) {
        const event = publication.payload.event;
        const expectedToken = sessionSubjectToken(event.sessionId);
        if (!message.subject.endsWith(`.${expectedToken}`)) {
          throw new Error("JetStream live event subject identity is invalid");
        }
        this.#eventHub.publish(envelope.tenantId, event);
      }
    }
  }

  async #observeStatus(): Promise<void> {
    for await (const status of this.#runtime.connection.status()) {
      if (status.type === "disconnect" || status.type === "reconnect") {
        this.#eventHub.resyncAll();
      }
    }
  }
}

export class JetStreamLiveTurnSnapshotSource implements LiveTurnSnapshotSource {
  readonly #database: Kysely<Database>;
  readonly #events: JetStreamLiveEventStore;

  constructor(options: { database: Kysely<Database>; events: JetStreamLiveEventStore }) {
    this.#database = options.database;
    this.#events = options.events;
  }

  async read(tenantId: string, sessionId: string): Promise<LiveTurnSnapshotResource> {
    const activeTurn = await this.#database
      .selectFrom("turns")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .where("state", "not in", ["completed", "failed", "cancelled"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const replay = await this.#events.openReplayWindow(tenantId, sessionId, 0).catch(() => ({
      events: [],
      highWaterMark: 0,
    }));
    if (activeTurn === undefined) {
      return parseLiveTurnSnapshotResource({
        sessionId,
        replayAfterSequence: replay.highWaterMark,
        turn: null,
      });
    }
    const events = await this.#events.readTurn(tenantId, sessionId, activeTurn.id);
    return parseLiveTurnSnapshotResource({
      sessionId,
      replayAfterSequence: events.at(-1)?.seq ?? replay.highWaterMark,
      turn:
        events.length === 0
          ? null
          : { turnId: activeTurn.id, transcript: projectConversationTurnTranscript(events) },
    });
  }
}

export class JetStreamTerminalTurnProjectionSource implements TerminalTurnProjectionSource {
  readonly #events: JetStreamLiveEventStore;
  readonly #database: Kysely<Database>;

  constructor(options: { database: Kysely<Database>; events: JetStreamLiveEventStore }) {
    this.#database = options.database;
    this.#events = options.events;
  }

  async prepare(
    input: PrepareTerminalTurnProjectionInput,
  ): Promise<PreparedTerminalTurnProjection> {
    const boundary = await this.#database
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", "attempt.id", "run.current_attempt_id")
      .select("attempt.last_event_seq as lastEventSequence")
      .where("run.tenant_id", "=", input.tenantId)
      .where("run.session_id", "=", input.sessionId)
      .where("run.turn_id", "=", input.turnId)
      .where("run.command_id", "=", input.commandId)
      .executeTakeFirst();
    if (boundary === undefined) throw new Error("Terminal projection RunAttempt is unavailable");
    const expectedSequence = Number(boundary.lastEventSequence);
    const deadline = Date.now() + 10_000;
    let events = await this.#events.readTurn(input.tenantId, input.sessionId, input.turnId);
    while ((events.at(-1)?.seq ?? 0) < expectedSequence && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      events = await this.#events.readTurn(input.tenantId, input.sessionId, input.turnId);
    }
    if (events.length === 0) throw new Error("No accepted JetStream live prefix is available");
    const previousSequence = events.at(-1)?.seq ?? 0;
    if (previousSequence !== expectedSequence) {
      throw new Error("Accepted JetStream live prefix has not reached the RunAttempt boundary");
    }
    const terminalEvent = parsePiCloudEvent({
      schemaVersion: 1,
      eventId: input.eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      seq: previousSequence + 1,
      occurredAt: input.occurredAt,
      ...input.body,
    });
    return {
      schemaVersion: 1,
      previousSequence,
      terminalEvent,
      transcript: projectConversationTurnTranscript([...events, terminalEvent]),
    };
  }
}

export class JetStreamTerminalEventOutboxRelay {
  readonly #database: Kysely<Database>;
  readonly #publisher: JetStreamAcceptedAgentEventPublisher;
  readonly #pollIntervalMs: number;
  #abort: AbortController | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    database: Kysely<Database>;
    publisher: JetStreamAcceptedAgentEventPublisher;
    pollIntervalMs?: number;
  }) {
    this.#database = options.database;
    this.#publisher = options.publisher;
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  start(): void {
    this.#abort = new AbortController();
    this.#task = this.#run(this.#abort.signal).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  checkHealth(): void {
    if (this.#task === undefined || this.#failure !== undefined) {
      throw new Error("JetStream terminal event relay is unhealthy");
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#task;
    this.#task = undefined;
  }

  async dispatchOne(): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("outbox")
        .select(["id", "payload"])
        .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
        .where("published_at", "is", null)
        .where("available_at", "<=", new Date())
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return false;
      const envelope = parseAcceptedAgentEventEnvelope(JSON.stringify(row.payload));
      await this.#publisher.append(envelope);
      const updated = await transaction
        .updateTable("outbox")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          published_at: new Date(),
          last_error: null,
        })
        .where("id", "=", row.id)
        .where("published_at", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error("Terminal event outbox claim was lost");
      return true;
    });
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.dispatchOne()) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollIntervalMs);
        timer.unref();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
