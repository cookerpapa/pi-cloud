import type { Database } from "@pi-cloud/database";
import {
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  parseControlToSupervisorMessage,
  parseLiveTurnSnapshotResource,
  parsePiCloudEvent,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type EventWriterOpenMessage,
  type LiveTurnSnapshotResource,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import { DeliverPolicy } from "@nats-io/jetstream";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  AgentEventWriterAuthorityError,
  PostgresAgentEventWriterAuthority,
  parseAcceptedAgentEventEnvelope,
  type AcceptedAgentEventEnvelope,
} from "./agent-event-authority.ts";
import { performance } from "node:perf_hooks";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import {
  DurableEventStoreError,
  type DurableEventIngestor,
  type DurableEventLog,
  type DurableEventWriter,
  type DurableEventWriterOpenRequest,
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
import WebSocket, { type RawData } from "ws";
import {
  type PrepareTerminalTurnProjectionInput,
  type PreparedTerminalTurnProjection,
  type TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

type LiveSubscription = ReturnType<PiCloudJetStream["connection"]["subscribe"]>;

function encodeEnvelope(envelope: AcceptedAgentEventEnvelope): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 2, tenantId: envelope.tenantId, events: envelope.events }),
  );
}

function acknowledgement(message: EventPublishMessage): EventAckMessage {
  const parsed = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.ack",
    payload: {
      sessionId: message.payload.event.sessionId,
      executionGrant: message.payload.executionGrant,
      acknowledgedThroughSeq: message.payload.event.seq,
    },
  });
  if (parsed.type !== "event.ack") throw new Error("Agent event ACK is invalid");
  return parsed;
}

export class JetStreamAcceptedAgentEventPublisher {
  readonly #runtime: PiCloudJetStream;
  readonly #maximumInFlight: number;
  readonly #waiters: Array<() => void> = [];
  #inFlight = 0;

  constructor(runtime: PiCloudJetStream, maximumInFlight = 128) {
    if (!Number.isSafeInteger(maximumInFlight) || maximumInFlight < 1 || maximumInFlight > 4_096) {
      throw new TypeError("maximumInFlight is invalid");
    }
    this.#runtime = runtime;
    this.#maximumInFlight = maximumInFlight;
  }

  async append(envelope: AcceptedAgentEventEnvelope): Promise<void> {
    await this.#acquire();
    try {
      const event = envelope.events[0]!;
      await this.#runtime.client.publish(
        agentEventSubject(event.sessionId),
        encodeEnvelope(envelope),
        {
          msgID: event.eventId,
          expect: { streamName: AGENT_EVENT_STREAM_NAME },
          timeout: 10_000,
        },
      );
    } finally {
      this.#release();
    }
  }

  async lastAcceptedEvent(sessionId: string): Promise<PiCloudEvent | undefined> {
    const stored = await this.#runtime.manager.streams.getMessage(AGENT_EVENT_STREAM_NAME, {
      last_by_subj: agentEventSubject(sessionId),
    });
    if (stored === null) return undefined;
    const envelope = parseAcceptedAgentEventEnvelope(stored.data);
    const event = envelope.events.at(-1);
    if (event === undefined || event.sessionId !== sessionId) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "JetStream Session tail does not match its Subject",
      );
    }
    return event;
  }

  async checkHealth(): Promise<void> {
    await this.#runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME);
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < this.#maximumInFlight) {
      this.#inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#inFlight -= 1;
    else waiter();
  }
}

export type AgentEventWriterSession = Readonly<{
  executionGrant: string;
  sessionId: string;
  turnId: string;
  acknowledgedThroughSeq: number;
  leaseDurationMs: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  close(): Promise<void>;
}>;

export type AgentEventWriterPublisherPort = Pick<
  JetStreamAcceptedAgentEventPublisher,
  "append" | "lastAcceptedEvent" | "checkHealth"
>;

export type AgentEventWriterServiceOptions = Readonly<{
  database: Kysely<Database>;
  publisher: AgentEventWriterPublisherPort;
  instanceId: string;
  leaseDurationMs?: number;
  maximumActiveWriters?: number;
  clock?: () => Date;
}>;

type AgentEventAppendPort = Pick<JetStreamAcceptedAgentEventPublisher, "append">;

function eventWriterError(error: unknown): DurableEventStoreError {
  if (error instanceof DurableEventStoreError) return error;
  if (error instanceof AgentEventWriterAuthorityError) {
    return new DurableEventStoreError(
      error.code === "event_writer_conflict"
        ? "event_conflict"
        : error.code === "event_writer_invariant"
          ? "event_store_invariant"
          : "stale_execution_grant",
      error.message,
      error.retryable,
    );
  }
  return new DurableEventStoreError("event_store_invariant", "Agent event writer failed", true);
}

class JetStreamAgentEventWriter implements AgentEventWriterSession {
  readonly executionGrant: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly #authority: PostgresAgentEventWriterAuthority;
  readonly #publisher: AgentEventAppendPort;
  readonly #scope: Awaited<ReturnType<PostgresAgentEventWriterAuthority["open"]>>;
  readonly #ensureLease: () => Promise<void>;
  #acknowledgedThroughSeq: number;
  #acknowledgedEventId: string | undefined;
  #leaseDurationMs: number;
  #usableUntil = 0;
  #publishing = false;
  #closed = false;
  #failure: DurableEventStoreError | undefined;

  constructor(options: {
    authority: PostgresAgentEventWriterAuthority;
    publisher: AgentEventAppendPort;
    scope: Awaited<ReturnType<PostgresAgentEventWriterAuthority["open"]>>;
    ensureLease: () => Promise<void>;
  }) {
    this.#authority = options.authority;
    this.#publisher = options.publisher;
    this.#scope = options.scope;
    this.#ensureLease = options.ensureLease;
    this.executionGrant = options.scope.executionGrant;
    this.sessionId = options.scope.sessionId;
    this.turnId = options.scope.turnId;
    this.#acknowledgedThroughSeq = options.scope.acknowledgedThroughSeq;
    this.#acknowledgedEventId = options.scope.acknowledgedEventId;
    this.#leaseDurationMs = options.scope.leaseDurationMs;
    this.#recordLease(options.scope.leaseDurationMs);
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  get leaseDurationMs(): number {
    return this.#leaseDurationMs;
  }

  get authorityScope(): Awaited<ReturnType<PostgresAgentEventWriterAuthority["open"]>> {
    return this.#scope;
  }

  get closed(): boolean {
    return this.#closed;
  }

  renewed(durationMs: number): void {
    if (!this.#closed) this.#recordLease(durationMs);
  }

  fail(error: unknown): void {
    if (!this.#closed && this.#failure === undefined) this.#failure = eventWriterError(error);
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    await this.#ensureLease();
    this.#assertUsable();
    if (this.#publishing) {
      throw new DurableEventStoreError(
        "event_conflict",
        "Agent event writer accepts one ordered publication at a time",
        true,
      );
    }
    const message = parseSupervisorToControlMessage(value);
    if (
      message.type !== "event.publish" ||
      message.payload.executionGrant !== this.executionGrant ||
      message.payload.event.sessionId !== this.sessionId ||
      message.payload.event.turnId !== this.turnId
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Agent event publication does not match its writer channel",
      );
    }
    const event = message.payload.event;
    if (event.seq === this.#acknowledgedThroughSeq && event.eventId === this.#acknowledgedEventId) {
      return acknowledgement(message);
    }
    if (event.seq <= this.#acknowledgedThroughSeq) {
      throw new DurableEventStoreError(
        "event_conflict",
        "Agent event sequence is already occupied by another durable event",
      );
    }
    if (event.seq !== this.#acknowledgedThroughSeq + 1) {
      throw new DurableEventStoreError("sequence_gap", "Agent event writer received a gap");
    }

    this.#publishing = true;
    try {
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      for (let attempt = 1; Date.now() < deadline; attempt += 1) {
        await this.#ensureLease();
        this.#assertUsable();
        try {
          await this.#publisher.append({
            schemaVersion: 2,
            tenantId: this.#scope.tenantId,
            events: [event],
          });
          lastError = undefined;
          break;
        } catch (error: unknown) {
          lastError = error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(remaining, Math.min(1_000, 100 * attempt))),
          );
        }
      }
      if (lastError !== undefined) {
        throw new DurableEventStoreError(
          "event_store_invariant",
          "JetStream did not acknowledge the Agent event before its deadline",
          true,
        );
      }
      this.#acknowledgedThroughSeq = event.seq;
      this.#acknowledgedEventId = event.eventId;
      return acknowledgement(message);
    } finally {
      this.#publishing = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#authority.close(this.#scope, this.#acknowledgedThroughSeq);
    } catch (error: unknown) {
      throw eventWriterError(error);
    }
  }

  #recordLease(durationMs: number): void {
    this.#leaseDurationMs = durationMs;
    const safetyMarginMs = Math.min(250, Math.max(1, Math.floor(durationMs / 4)));
    this.#usableUntil = performance.now() + Math.max(1, durationMs - safetyMarginMs);
  }

  #assertUsable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed || performance.now() >= this.#usableUntil) {
      throw new DurableEventStoreError("stale_execution_grant", "Agent event writer lease expired");
    }
  }
}

export class JetStreamAgentEventWriterService {
  readonly #authority: PostgresAgentEventWriterAuthority;
  readonly #publisher: AgentEventWriterPublisherPort;
  readonly #instanceId: string;
  readonly #renewalIntervalMs: number;
  readonly #maximumActiveWriters: number;
  readonly #writers = new Map<
    string,
    {
      writer: JetStreamAgentEventWriter;
      onFailure: (error: DurableEventStoreError) => void;
    }
  >();
  #renewTimer: NodeJS.Timeout | undefined;
  #renewing: Promise<void> | undefined;
  #renewDueAt = 0;
  #openedWriters = 0;
  #publishedEvents = 0;
  #renewalCycles = 0;
  #renewalFailures = 0;
  #openingWriters = 0;

  constructor(options: AgentEventWriterServiceOptions) {
    this.#authority = new PostgresAgentEventWriterAuthority({
      database: options.database,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
    });
    this.#publisher = options.publisher;
    this.#instanceId = options.instanceId;
    this.#renewalIntervalMs = Math.max(1, Math.floor((options.leaseDurationMs ?? 9_000) / 4));
    this.#maximumActiveWriters = options.maximumActiveWriters ?? 128;
    if (
      !Number.isSafeInteger(this.#maximumActiveWriters) ||
      this.#maximumActiveWriters < 1 ||
      this.#maximumActiveWriters > 10_000
    ) {
      throw new TypeError("maximumActiveWriters is invalid");
    }
  }

  async open(
    message: EventWriterOpenMessage,
    connectionId: string,
    onFailure: (error: DurableEventStoreError) => void,
  ): Promise<AgentEventWriterSession> {
    if (this.#writers.size + this.#openingWriters >= this.#maximumActiveWriters) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "Agent event writer Gateway is at capacity",
        true,
      );
    }
    this.#openingWriters += 1;
    let scope: Awaited<ReturnType<PostgresAgentEventWriterAuthority["open"]>>;
    try {
      const last = await this.#publisher.lastAcceptedEvent(message.payload.sessionId);
      scope = await this.#authority.open(
        message,
        { connectionId, instanceId: this.#instanceId },
        last === undefined ? undefined : { eventId: last.eventId, seq: last.seq },
      );
    } catch (error: unknown) {
      throw eventWriterError(error);
    } finally {
      this.#openingWriters -= 1;
    }
    this.#openedWriters += 1;
    const writer = new JetStreamAgentEventWriter({
      authority: this.#authority,
      publisher: {
        append: async (envelope) => {
          await this.#publisher.append(envelope);
          this.#publishedEvents += envelope.events.length;
        },
      },
      scope,
      ensureLease: () => this.#renewIfDue(false),
    });
    this.#writers.set(scope.connectionId, { writer, onFailure });
    this.#scheduleRenewal();
    let closed = false;
    return {
      executionGrant: writer.executionGrant,
      sessionId: writer.sessionId,
      turnId: writer.turnId,
      get acknowledgedThroughSeq() {
        return writer.acknowledgedThroughSeq;
      },
      get leaseDurationMs() {
        return writer.leaseDurationMs;
      },
      ingest: (value) => writer.ingest(value),
      close: async () => {
        if (closed) return;
        closed = true;
        this.#writers.delete(scope.connectionId);
        await writer.close();
      },
    };
  }

  async checkHealth(): Promise<void> {
    await this.#publisher.checkHealth();
  }

  async close(): Promise<void> {
    if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
    await this.#renewing?.catch(() => undefined);
    const writers = [...this.#writers.values()];
    this.#writers.clear();
    await Promise.allSettled(writers.map(({ writer }) => writer.close()));
  }

  statistics(): Readonly<{
    openedWriters: number;
    activeWriters: number;
    publishedEvents: number;
    renewalCycles: number;
    renewalFailures: number;
    maximumActiveWriters: number;
  }> {
    return {
      openedWriters: this.#openedWriters,
      activeWriters: this.#writers.size,
      publishedEvents: this.#publishedEvents,
      renewalCycles: this.#renewalCycles,
      renewalFailures: this.#renewalFailures,
      maximumActiveWriters: this.#maximumActiveWriters,
    };
  }

  #scheduleRenewal(): void {
    if (this.#writers.size === 0) return;
    if (this.#renewDueAt === 0) this.#renewDueAt = performance.now() + this.#renewalIntervalMs;
    if (this.#renewTimer !== undefined) return;
    this.#renewTimer = setTimeout(
      () => {
        this.#renewTimer = undefined;
        void this.#renewIfDue(true);
      },
      Math.max(1, this.#renewDueAt - performance.now()),
    );
    this.#renewTimer.unref();
  }

  async #renewIfDue(force: boolean): Promise<void> {
    if (this.#writers.size === 0) return;
    if (!force && performance.now() < this.#renewDueAt) return;
    if (this.#renewing === undefined) {
      if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
      this.#renewTimer = undefined;
      this.#renewing = this.#renewAll().finally(() => {
        this.#renewing = undefined;
        this.#renewDueAt = performance.now() + this.#renewalIntervalMs;
        this.#scheduleRenewal();
      });
    }
    await this.#renewing;
  }

  async #renewAll(): Promise<void> {
    const entries = [...this.#writers.values()];
    if (entries.length === 0) return;
    this.#renewalCycles += 1;
    for (let offset = 0; offset < entries.length; offset += 1_000) {
      const chunk = entries.slice(offset, offset + 1_000);
      let renewed: ReadonlyMap<string, number>;
      try {
        renewed = await this.#authority.renewMany(
          chunk.map(({ writer }) => ({
            scope: writer.authorityScope,
            acknowledgedThroughSeq: writer.acknowledgedThroughSeq,
          })),
        );
      } catch (error: unknown) {
        for (const entry of chunk) this.#failWriter(entry, error);
        continue;
      }
      for (const entry of chunk) {
        if (entry.writer.closed) continue;
        const durationMs = renewed.get(entry.writer.authorityScope.connectionId);
        if (durationMs === undefined) {
          this.#failWriter(
            entry,
            new AgentEventWriterAuthorityError(
              "stale_execution_grant",
              "Agent event writer was not renewed by PostgreSQL authority",
              false,
            ),
          );
        } else {
          entry.writer.renewed(durationMs);
        }
      }
    }
  }

  #failWriter(
    entry: {
      writer: JetStreamAgentEventWriter;
      onFailure: (error: DurableEventStoreError) => void;
    },
    error: unknown,
  ): void {
    if (entry.writer.closed) return;
    this.#renewalFailures += 1;
    const failure = eventWriterError(error);
    entry.writer.fail(failure);
    entry.onFailure(failure);
  }
}

export const AGENT_EVENT_INGEST_PATH = "/internal/v1/agent-events";
export const AGENT_EVENT_WRITER_PATH = `${AGENT_EVENT_INGEST_PATH}/writer`;

function remoteWriterUrl(baseUrl: string, allowInsecureHttp: boolean): URL {
  const url = new URL(AGENT_EVENT_WRITER_PATH, baseUrl);
  if (url.protocol === "http:") {
    if (!allowInsecureHttp) {
      throw new TypeError("Plain HTTP Agent event ingest requires explicit opt-in");
    }
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new TypeError("Agent event ingest base URL must use HTTP or HTTPS");
  }
  return url;
}

function remoteTextFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

type PendingRemoteExchange = {
  expectedType: "event.writer.ready" | "event.ack" | "event.writer.closed";
  settle: (
    result: { message: ReturnType<typeof parseControlToSupervisorMessage> } | { error: Error },
  ) => void;
  timer: NodeJS.Timeout;
};

class RemoteAgentEventWriter implements DurableEventWriter {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #request: DurableEventWriterOpenRequest;
  readonly #onClose: () => void;
  #socket: WebSocket | undefined;
  #pending: PendingRemoteExchange | undefined;
  #connecting: Promise<boolean> | undefined;
  #acknowledgedThroughSeq: number;
  #closed = false;

  constructor(options: {
    url: URL;
    authorization: string;
    request: DurableEventWriterOpenRequest;
    onClose: () => void;
  }) {
    this.#url = options.url;
    this.#authorization = options.authorization;
    this.#request = options.request;
    this.#onClose = options.onClose;
    this.#acknowledgedThroughSeq = options.request.nextEventSeq - 1;
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  async open(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.#ensureConnected(deadline)) return;
      this.#resetSocket(new Error("Agent event writer open will retry"));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Agent event writer could not open its transport",
      true,
    );
  }

  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetSocket(new Error("Agent event writer aborted"));
    this.#onClose();
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    if (this.#closed) throw new DurableEventStoreError("invalid_event", "Event writer is closed");
    const message = parseSupervisorToControlMessage(value);
    if (
      message.type !== "event.publish" ||
      message.payload.executionGrant !== this.#request.executionGrant ||
      message.payload.event.sessionId !== this.#request.sessionId ||
      message.payload.event.turnId !== this.#request.turnId
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Event publication does not match its remote writer",
      );
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        if (!(await this.#ensureConnected(deadline))) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const exchanged = await this.#exchange(message, "event.ack", deadline);
        if ("error" in exchanged) {
          this.#resetSocket(exchanged.error);
          if (Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
          continue;
        }
        const response = exchanged.message;
        if (
          response.type !== "event.ack" ||
          response.payload.executionGrant !== this.#request.executionGrant ||
          response.payload.sessionId !== this.#request.sessionId ||
          response.payload.acknowledgedThroughSeq !== message.payload.event.seq
        ) {
          throw new DurableEventStoreError(
            "invalid_event",
            "Remote Agent event ACK does not match its publication",
          );
        }
        this.#acknowledgedThroughSeq = response.payload.acknowledgedThroughSeq;
        return response;
      } catch (error: unknown) {
        this.#resetSocket(
          error instanceof Error ? error : new Error("Agent event writer transport failed"),
        );
        if (error instanceof DurableEventStoreError && !error.retryable) throw error;
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Agent event writer is unavailable",
      true,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const deadline = Date.now() + 30_000;
    let failure: unknown;
    try {
      while (Date.now() < deadline) {
        try {
          if (!(await this.#ensureConnected(deadline))) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            continue;
          }
          const closeMessage = parseSupervisorToControlMessage({
            protocolVersion: 1,
            messageId: globalThis.crypto.randomUUID(),
            sentAt: new Date().toISOString(),
            type: "event.writer.close",
            payload: {
              executionGrant: this.#request.executionGrant,
              acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
            },
          });
          const exchanged = await this.#exchange(closeMessage, "event.writer.closed", deadline);
          if ("error" in exchanged) {
            failure = exchanged.error;
            this.#resetSocket(exchanged.error);
            if (Date.now() < deadline) {
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            continue;
          }
          const response = exchanged.message;
          if (
            response.type !== "event.writer.closed" ||
            response.payload.acknowledgedMessageId !== closeMessage.messageId ||
            response.payload.executionGrant !== this.#request.executionGrant ||
            response.payload.acknowledgedThroughSeq !== this.#acknowledgedThroughSeq
          ) {
            throw new DurableEventStoreError(
              "invalid_event",
              "Remote Agent event writer close ACK is invalid",
            );
          }
          failure = undefined;
          return;
        } catch (error: unknown) {
          failure = error;
          this.#resetSocket(
            error instanceof Error ? error : new Error("Agent event writer close failed"),
          );
          if (Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      throw eventWriterError(failure);
    } finally {
      this.#closed = true;
      this.#resetSocket(new Error("Agent event writer closed"));
      this.#onClose();
    }
  }

  async #ensureConnected(deadline: number): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#socket?.readyState === WebSocket.OPEN) return true;
    if (this.#connecting === undefined) {
      const connecting = this.#connect(deadline).finally(() => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      });
      void connecting.catch(() => undefined);
      this.#connecting = connecting;
    }
    return this.#connecting;
  }

  async #connect(deadline: number): Promise<boolean> {
    const socket = new WebSocket(this.#url, {
      headers: { authorization: this.#authorization },
      perMessageDeflate: false,
      handshakeTimeout: Math.max(1, Math.min(10_000, deadline - Date.now())),
      maxPayload: 1024 * 1024,
    });
    this.#socket = socket;
    const opened = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(
        () => resolve(false),
        Math.max(1, Math.min(10_000, deadline - Date.now())),
      );
      const opened = (): void => {
        clearTimeout(timeout);
        socket.off("error", failed);
        resolve(true);
      };
      const failed = (): void => {
        clearTimeout(timeout);
        socket.off("open", opened);
        resolve(false);
      };
      socket.once("open", opened);
      socket.once("error", failed);
    });
    if (!opened) {
      if (this.#socket === socket) this.#socket = undefined;
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      return false;
    }
    socket.on("message", (data, isBinary) => this.#receive(data, isBinary));
    socket.once("close", () => {
      if (this.#socket === socket) {
        try {
          this.#resetSocket(new Error("Agent event writer disconnected"));
        } catch {
          this.#socket = undefined;
        }
      }
    });
    socket.once("error", (error) => {
      if (this.#socket === socket) {
        try {
          this.#resetSocket(error);
        } catch {
          this.#socket = undefined;
        }
      }
    });
    const openMessage = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "event.writer.open",
      payload: this.#request,
    });
    const exchanged = await this.#exchange(openMessage, "event.writer.ready", deadline);
    if ("error" in exchanged) return false;
    const response = exchanged.message;
    if (
      response.type !== "event.writer.ready" ||
      response.payload.acknowledgedMessageId !== openMessage.messageId ||
      response.payload.executionGrant !== this.#request.executionGrant ||
      response.payload.sessionId !== this.#request.sessionId ||
      response.payload.turnId !== this.#request.turnId
    ) {
      return false;
    }
    this.#acknowledgedThroughSeq = Math.max(
      this.#acknowledgedThroughSeq,
      response.payload.acknowledgedThroughSeq,
    );
    return true;
  }

  #exchange(
    message: unknown,
    expectedType: PendingRemoteExchange["expectedType"],
    deadline: number,
  ): Promise<{ message: ReturnType<typeof parseControlToSupervisorMessage> } | { error: Error }> {
    if (this.#pending !== undefined) {
      return Promise.resolve({
        error: new DurableEventStoreError(
          "event_conflict",
          "Agent event writer already has an in-flight frame",
          true,
        ),
      });
    }
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: new Error("Agent event writer socket is not open") });
    }
    return new Promise<
      { message: ReturnType<typeof parseControlToSupervisorMessage> } | { error: Error }
    >((settle) => {
      const timer = setTimeout(
        () => {
          if (this.#pending?.timer !== timer) return;
          this.#pending = undefined;
          settle({ error: new Error("Agent event writer frame timed out") });
        },
        Math.max(1, Math.min(60_000, deadline - Date.now())),
      );
      this.#pending = { expectedType, settle, timer };
      socket.send(JSON.stringify(message), (error) => {
        if (error == null || this.#pending?.timer !== timer) return;
        clearTimeout(timer);
        this.#pending = undefined;
        settle({ error });
      });
    });
  }

  #receive(data: RawData, isBinary: boolean): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    if (isBinary) {
      this.#resetSocket(new Error("Agent event writer received a binary frame"));
      return;
    }
    let response;
    try {
      response = parseControlToSupervisorMessage(JSON.parse(remoteTextFrame(data)));
    } catch (error: unknown) {
      this.#resetSocket(error instanceof Error ? error : new Error("Invalid event writer frame"));
      return;
    }
    if (response.type !== pending.expectedType) {
      this.#resetSocket(new Error("Agent event writer response type is invalid"));
      return;
    }
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.settle({ message: response });
  }

  #resetSocket(error: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.settle({ error });
    }
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

export class WebSocketAgentEventIngestor implements DurableEventIngestor {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #healthUrl: URL;
  readonly #writers = new Set<RemoteAgentEventWriter>();
  #closed = false;

  constructor(options: { baseUrl: string; serviceToken: string; allowInsecureHttp: boolean }) {
    this.#url = remoteWriterUrl(options.baseUrl, options.allowInsecureHttp);
    this.#healthUrl = new URL(`${AGENT_EVENT_INGEST_PATH}/health`, options.baseUrl);
    this.#authorization = `Bearer ${options.serviceToken}`;
  }

  async open(request: DurableEventWriterOpenRequest): Promise<DurableEventWriter> {
    if (this.#closed) throw new Error("Agent event ingestor is closed");
    let writer!: RemoteAgentEventWriter;
    writer = new RemoteAgentEventWriter({
      url: this.#url,
      authorization: this.#authorization,
      request,
      onClose: () => this.#writers.delete(writer),
    });
    this.#writers.add(writer);
    try {
      await writer.open();
      return writer;
    } catch (error: unknown) {
      writer.abort();
      throw error;
    }
  }

  async checkHealth(): Promise<void> {
    const response = await fetch(this.#healthUrl, {
      headers: { authorization: this.#authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Agent event ingest service is unavailable");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#writers].map((writer) => writer.close()));
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
        for (const event of envelope.events) events.push(event);
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
      for (const event of envelope.events) {
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
      .innerJoin("execution_grants as authority", (join) =>
        join
          .onRef("authority.execution_id", "=", "attempt.id")
          .onRef("authority.run_id", "=", "run.id"),
      )
      .select("authority.last_event_seq as lastEventSequence")
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
