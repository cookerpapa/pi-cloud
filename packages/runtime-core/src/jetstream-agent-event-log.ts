import type { Database } from "@pi-cloud/database";
import {
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  parseControlToSupervisorMessage,
  parseLiveTurnSnapshotResource,
  parsePiCloudEvent,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type FactChannelOpenMessage,
  type LiveTurnSnapshotResource,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import { DeliverPolicy } from "@nats-io/jetstream";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  ExecutionGrantAuthorityGateError,
  PostgresExecutionGrantAuthorityGate,
} from "./execution-grant-authority-gate.ts";
import { performance } from "node:perf_hooks";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import {
  DurableEventStoreError,
  type FactChannelFactory,
  type DurableEventLog,
  type FactChannel,
  type FactChannelOpenRequest,
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
import type {
  AcceptedAgentEventEnvelope,
  AcceptedFactBus,
  ActiveFactChannelResolver,
  CandidateFact,
  CandidatePiSessionMutationFact,
  PiSessionMutationAcceptedFrame,
  PiSessionMutationFactChannel,
  PiSessionMutationPublishFrame,
} from "./accepted-fact.ts";
import { parseAcceptedAgentEventEnvelope } from "./accepted-fact.ts";

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

export type AcceptedFactChannelSession = Readonly<{
  executionGrant: string;
  sessionId: string;
  turnId: string;
  acknowledgedThroughSeq: number;
  leaseDurationMs: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  mutate(
    mutation: CandidatePiSessionMutationFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>>;
  close(): Promise<void>;
}>;

export type FactChannelServiceOptions = Readonly<{
  authority: PostgresExecutionGrantAuthorityGate;
  bus: AcceptedFactBus;
  instanceId: string;
  leaseDurationMs?: number;
  maximumActiveChannels?: number;
}>;

function factChannelError(error: unknown): DurableEventStoreError {
  if (error instanceof DurableEventStoreError) return error;
  if (error instanceof ExecutionGrantAuthorityGateError) {
    return new DurableEventStoreError(
      error.code === "fact_channel_conflict"
        ? "event_conflict"
        : error.code === "authority_invariant"
          ? "event_store_invariant"
          : "stale_execution_grant",
      error.message,
      error.retryable,
    );
  }
  return new DurableEventStoreError("event_store_invariant", "FactChannel failed", true);
}

class ServerFactChannel implements AcceptedFactChannelSession {
  readonly executionGrant: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly #authority: PostgresExecutionGrantAuthorityGate;
  readonly #bus: AcceptedFactBus;
  readonly #scope: Awaited<ReturnType<PostgresExecutionGrantAuthorityGate["open"]>>;
  readonly #ensureLease: () => Promise<void>;
  #acknowledgedThroughSeq: number;
  #leaseDurationMs: number;
  #usableUntil = 0;
  #publishing = false;
  #closed = false;
  #failure: DurableEventStoreError | undefined;

  constructor(options: {
    authority: PostgresExecutionGrantAuthorityGate;
    bus: AcceptedFactBus;
    scope: Awaited<ReturnType<PostgresExecutionGrantAuthorityGate["open"]>>;
    acknowledgedThroughSeq: number;
    ensureLease: () => Promise<void>;
  }) {
    this.#authority = options.authority;
    this.#bus = options.bus;
    this.#scope = options.scope;
    this.#ensureLease = options.ensureLease;
    this.executionGrant = options.scope.executionGrant;
    this.sessionId = options.scope.sessionId;
    this.turnId = options.scope.turnId;
    this.#acknowledgedThroughSeq = options.acknowledgedThroughSeq;
    this.#leaseDurationMs = options.scope.leaseDurationMs;
    this.#recordLease(options.scope.leaseDurationMs);
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  get leaseDurationMs(): number {
    return this.#leaseDurationMs;
  }

  get authorityScope(): Awaited<ReturnType<PostgresExecutionGrantAuthorityGate["open"]>> {
    return this.#scope;
  }

  get closed(): boolean {
    return this.#closed;
  }

  renewed(durationMs: number): void {
    if (!this.#closed) this.#recordLease(durationMs);
  }

  fail(error: unknown): void {
    if (!this.#closed && this.#failure === undefined) this.#failure = factChannelError(error);
  }

  async ingest(value: unknown): Promise<EventAckMessage> {
    await this.#ensureLease();
    this.#assertUsable();
    if (this.#publishing) {
      throw new DurableEventStoreError(
        "event_conflict",
        "FactChannel accepts one ordered publication at a time",
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
        "Agent event publication does not match its FactChannel",
      );
    }
    await this.#append({ kind: "agent_event", publication: message });
    this.#acknowledgedThroughSeq = Math.max(
      this.#acknowledgedThroughSeq,
      message.payload.event.seq,
    );
    return acknowledgement(message);
  }

  async mutate(
    mutation: CandidatePiSessionMutationFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>> {
    await this.#append({ kind: "pi_session_mutation", mutation });
    return { mutationId: mutation.mutationId, accepted: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#authority.close(this.#scope);
    } catch (error: unknown) {
      throw factChannelError(error);
    }
  }

  #recordLease(durationMs: number): void {
    this.#leaseDurationMs = durationMs;
    const safetyMarginMs = Math.min(250, Math.max(1, Math.floor(durationMs / 4)));
    this.#usableUntil = performance.now() + Math.max(1, durationMs - safetyMarginMs);
  }

  async #append(candidate: CandidateFact): Promise<void> {
    await this.#ensureLease();
    this.#assertUsable();
    if (this.#publishing) {
      throw new DurableEventStoreError(
        "event_conflict",
        "FactChannel accepts one publication at a time",
        true,
      );
    }
    const accepted = this.#authority.accept(this.#scope, candidate);
    this.#publishing = true;
    try {
      const deadline = Date.now() + 30_000;
      let lastError: unknown;
      for (let attempt = 1; Date.now() < deadline; attempt += 1) {
        await this.#ensureLease();
        this.#assertUsable();
        try {
          const receipt = await this.#bus.append(accepted);
          if (!receipt.durable || receipt.factId !== accepted.factId) {
            throw new Error("AcceptedFactBus returned an unrelated receipt");
          }
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
          "AcceptedFactBus did not durably acknowledge the Fact before its deadline",
          true,
        );
      }
    } finally {
      this.#publishing = false;
    }
  }

  #assertUsable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed || performance.now() >= this.#usableUntil) {
      throw new DurableEventStoreError("stale_execution_grant", "FactChannel lease expired");
    }
  }
}

export class FactChannelService {
  readonly #authority: PostgresExecutionGrantAuthorityGate;
  readonly #bus: AcceptedFactBus;
  readonly #instanceId: string;
  readonly #renewalIntervalMs: number;
  readonly #maximumActiveChannels: number;
  readonly #channels = new Map<
    string,
    {
      channel: ServerFactChannel;
      onFailure: (error: DurableEventStoreError) => void;
    }
  >();
  #renewTimer: NodeJS.Timeout | undefined;
  #renewing: Promise<void> | undefined;
  #renewDueAt = 0;
  #openedChannels = 0;
  #publishedFacts = 0;
  #renewalCycles = 0;
  #renewalFailures = 0;
  #openingChannels = 0;

  constructor(options: FactChannelServiceOptions) {
    this.#authority = options.authority;
    this.#bus = options.bus;
    this.#instanceId = options.instanceId;
    this.#renewalIntervalMs = Math.max(1, Math.floor((options.leaseDurationMs ?? 9_000) / 4));
    this.#maximumActiveChannels = options.maximumActiveChannels ?? 128;
    if (
      !Number.isSafeInteger(this.#maximumActiveChannels) ||
      this.#maximumActiveChannels < 1 ||
      this.#maximumActiveChannels > 10_000
    ) {
      throw new TypeError("maximumActiveChannels is invalid");
    }
  }

  async open(
    message: FactChannelOpenMessage,
    connectionId: string,
    onFailure: (error: DurableEventStoreError) => void,
  ): Promise<AcceptedFactChannelSession> {
    if (this.#channels.size + this.#openingChannels >= this.#maximumActiveChannels) {
      throw new DurableEventStoreError(
        "event_store_invariant",
        "FactChannel Gateway is at capacity",
        true,
      );
    }
    this.#openingChannels += 1;
    let scope: Awaited<ReturnType<PostgresExecutionGrantAuthorityGate["open"]>>;
    try {
      scope = await this.#authority.open(
        {
          executionGrant: message.payload.executionGrant,
          sessionId: message.payload.sessionId,
          turnId: message.payload.turnId,
        },
        { connectionId, instanceId: this.#instanceId },
      );
    } catch (error: unknown) {
      throw factChannelError(error);
    } finally {
      this.#openingChannels -= 1;
    }
    this.#openedChannels += 1;
    const channel = new ServerFactChannel({
      authority: this.#authority,
      bus: {
        append: async (fact) => {
          const receipt = await this.#bus.append(fact);
          this.#publishedFacts += 1;
          return receipt;
        },
        checkHealth: () => this.#bus.checkHealth(),
      },
      scope,
      acknowledgedThroughSeq: message.payload.nextEventSeq - 1,
      ensureLease: () => this.#renewIfDue(false),
    });
    this.#channels.set(scope.connectionId, { channel, onFailure });
    this.#scheduleRenewal();
    let closed = false;
    return {
      executionGrant: channel.executionGrant,
      sessionId: channel.sessionId,
      turnId: channel.turnId,
      get acknowledgedThroughSeq() {
        return channel.acknowledgedThroughSeq;
      },
      get leaseDurationMs() {
        return channel.leaseDurationMs;
      },
      ingest: (value) => channel.ingest(value),
      mutate: (mutation) => channel.mutate(mutation),
      close: async () => {
        if (closed) return;
        closed = true;
        this.#channels.delete(scope.connectionId);
        await channel.close();
      },
    };
  }

  async checkHealth(): Promise<void> {
    await this.#bus.checkHealth();
  }

  async close(): Promise<void> {
    if (this.#renewTimer !== undefined) clearTimeout(this.#renewTimer);
    await this.#renewing?.catch(() => undefined);
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    await Promise.allSettled(channels.map(({ channel }) => channel.close()));
  }

  statistics(): Readonly<{
    openedChannels: number;
    activeChannels: number;
    publishedFacts: number;
    renewalCycles: number;
    renewalFailures: number;
    maximumActiveChannels: number;
  }> {
    return {
      openedChannels: this.#openedChannels,
      activeChannels: this.#channels.size,
      publishedFacts: this.#publishedFacts,
      renewalCycles: this.#renewalCycles,
      renewalFailures: this.#renewalFailures,
      maximumActiveChannels: this.#maximumActiveChannels,
    };
  }

  #scheduleRenewal(): void {
    if (this.#channels.size === 0) return;
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
    if (this.#channels.size === 0) return;
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
    const entries = [...this.#channels.values()];
    if (entries.length === 0) return;
    this.#renewalCycles += 1;
    for (let offset = 0; offset < entries.length; offset += 1_000) {
      const chunk = entries.slice(offset, offset + 1_000);
      let renewed: ReadonlyMap<string, number>;
      try {
        renewed = await this.#authority.renewMany(
          chunk.map(({ channel }) => channel.authorityScope),
        );
      } catch (error: unknown) {
        for (const entry of chunk) this.#failChannel(entry, error);
        continue;
      }
      for (const entry of chunk) {
        if (entry.channel.closed) continue;
        const durationMs = renewed.get(entry.channel.authorityScope.connectionId);
        if (durationMs === undefined) {
          this.#failChannel(
            entry,
            new ExecutionGrantAuthorityGateError(
              "stale_execution_grant",
              "FactChannel was not renewed by PostgreSQL authority",
              false,
            ),
          );
        } else {
          entry.channel.renewed(durationMs);
        }
      }
    }
  }

  #failChannel(
    entry: {
      channel: ServerFactChannel;
      onFailure: (error: DurableEventStoreError) => void;
    },
    error: unknown,
  ): void {
    if (entry.channel.closed) return;
    this.#renewalFailures += 1;
    const failure = factChannelError(error);
    entry.channel.fail(failure);
    entry.onFailure(failure);
  }
}

export const ACCEPTED_FACT_INGEST_PATH = "/internal/v1/accepted-facts";
export const FACT_CHANNEL_PATH = `${ACCEPTED_FACT_INGEST_PATH}/channel`;

function factChannelUrl(baseUrl: string, allowInsecureHttp: boolean): URL {
  const url = new URL(FACT_CHANNEL_PATH, baseUrl);
  if (url.protocol === "http:") {
    if (!allowInsecureHttp) {
      throw new TypeError("Plain HTTP FactChannel requires explicit opt-in");
    }
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new TypeError("FactChannel base URL must use HTTP or HTTPS");
  }
  return url;
}

function remoteTextFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

type PendingRemoteExchange = {
  expectedType:
    | "fact.channel.ready"
    | "event.ack"
    | "fact.channel.closed"
    | "fact.pi_session_mutation.accepted";
  settle: (result: { message: RemoteFactChannelResponse } | { error: Error }) => void;
  timer: NodeJS.Timeout;
};

type RemoteFactChannelResponse =
  ReturnType<typeof parseControlToSupervisorMessage> | PiSessionMutationAcceptedFrame;

class RemoteFactChannel implements FactChannel {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #request: FactChannelOpenRequest;
  readonly #onClose: () => void;
  #socket: WebSocket | undefined;
  #pending: PendingRemoteExchange | undefined;
  #connecting: Promise<boolean> | undefined;
  #operationTail = Promise.resolve();
  #acknowledgedThroughSeq: number;
  #closed = false;

  constructor(options: {
    url: URL;
    authorization: string;
    request: FactChannelOpenRequest;
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
      this.#resetSocket(new Error("FactChannel open will retry"));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "FactChannel could not open its transport",
      true,
    );
  }

  mutate(
    mutation: CandidatePiSessionMutationFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>> {
    return this.#serialize(() => this.#mutate(mutation));
  }

  async #mutate(
    mutation: CandidatePiSessionMutationFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>> {
    if (this.#closed) throw new DurableEventStoreError("invalid_event", "FactChannel is closed");
    const frame: PiSessionMutationPublishFrame = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "fact.pi_session_mutation.publish",
      payload: mutation,
    };
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!(await this.#ensureConnected(deadline))) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const exchanged = await this.#exchange(frame, "fact.pi_session_mutation.accepted", deadline);
      if ("error" in exchanged) {
        this.#resetSocket(exchanged.error);
        if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const response = exchanged.message;
      if (
        response.type === "fact.pi_session_mutation.accepted" &&
        response.payload.acknowledgedMessageId === frame.messageId &&
        response.payload.mutationId === mutation.mutationId &&
        response.payload.accepted
      ) {
        return { mutationId: mutation.mutationId, accepted: true };
      }
      this.#resetSocket(new Error("FactChannel mutation acknowledgement is unrelated"));
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "FactChannel mutation acceptance timed out",
      true,
    );
  }

  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetSocket(new Error("FactChannel aborted"));
    this.#onClose();
  }

  ingest(value: unknown): Promise<EventAckMessage> {
    return this.#serialize(() => this.#ingest(value));
  }

  async #ingest(value: unknown): Promise<EventAckMessage> {
    if (this.#closed) throw new DurableEventStoreError("invalid_event", "Event channel is closed");
    const message = parseSupervisorToControlMessage(value);
    if (
      message.type !== "event.publish" ||
      message.payload.executionGrant !== this.#request.executionGrant ||
      message.payload.event.sessionId !== this.#request.sessionId ||
      message.payload.event.turnId !== this.#request.turnId
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Event publication does not match its remote channel",
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
          error instanceof Error ? error : new Error("FactChannel transport failed"),
        );
        if (error instanceof DurableEventStoreError && !error.retryable) throw error;
        if (Date.now() >= deadline) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new DurableEventStoreError("event_store_invariant", "FactChannel is unavailable", true);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#operationTail;
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
            type: "fact.channel.close",
            payload: {
              executionGrant: this.#request.executionGrant,
              acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
            },
          });
          const exchanged = await this.#exchange(closeMessage, "fact.channel.closed", deadline);
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
            response.type !== "fact.channel.closed" ||
            response.payload.acknowledgedMessageId !== closeMessage.messageId ||
            response.payload.executionGrant !== this.#request.executionGrant ||
            response.payload.acknowledgedThroughSeq !== this.#acknowledgedThroughSeq
          ) {
            throw new DurableEventStoreError(
              "invalid_event",
              "Remote FactChannel close ACK is invalid",
            );
          }
          failure = undefined;
          return;
        } catch (error: unknown) {
          failure = error;
          this.#resetSocket(error instanceof Error ? error : new Error("FactChannel close failed"));
          if (Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      throw factChannelError(failure);
    } finally {
      this.#closed = true;
      this.#resetSocket(new Error("FactChannel closed"));
      this.#onClose();
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
          this.#resetSocket(new Error("FactChannel disconnected"));
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
      type: "fact.channel.open",
      payload: this.#request,
    });
    const exchanged = await this.#exchange(openMessage, "fact.channel.ready", deadline);
    if ("error" in exchanged) return false;
    const response = exchanged.message;
    if (
      response.type !== "fact.channel.ready" ||
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
  ): Promise<{ message: RemoteFactChannelResponse } | { error: Error }> {
    if (this.#pending !== undefined) {
      return Promise.resolve({
        error: new DurableEventStoreError(
          "event_conflict",
          "FactChannel already has an in-flight frame",
          true,
        ),
      });
    }
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: new Error("FactChannel socket is not open") });
    }
    return new Promise<{ message: RemoteFactChannelResponse } | { error: Error }>((settle) => {
      const timer = setTimeout(
        () => {
          if (this.#pending?.timer !== timer) return;
          this.#pending = undefined;
          settle({ error: new Error("FactChannel frame timed out") });
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
      this.#resetSocket(new Error("FactChannel received a binary frame"));
      return;
    }
    let response: RemoteFactChannelResponse;
    try {
      const value = JSON.parse(remoteTextFrame(data)) as RemoteFactChannelResponse;
      response =
        value.type === "fact.pi_session_mutation.accepted"
          ? value
          : parseControlToSupervisorMessage(value);
    } catch (error: unknown) {
      this.#resetSocket(error instanceof Error ? error : new Error("Invalid FactChannel frame"));
      return;
    }
    if (response.type !== pending.expectedType) {
      this.#resetSocket(new Error("FactChannel response type is invalid"));
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

export class WebSocketAcceptedFactIngestor
  implements FactChannelFactory, ActiveFactChannelResolver
{
  readonly #url: URL;
  readonly #authorization: string;
  readonly #healthUrl: URL;
  readonly #channels = new Map<string, RemoteFactChannel>();
  #closed = false;

  constructor(options: { baseUrl: string; serviceToken: string; allowInsecureHttp: boolean }) {
    this.#url = factChannelUrl(options.baseUrl, options.allowInsecureHttp);
    this.#healthUrl = new URL(`${ACCEPTED_FACT_INGEST_PATH}/health`, options.baseUrl);
    this.#authorization = `Bearer ${options.serviceToken}`;
  }

  async open(request: FactChannelOpenRequest): Promise<FactChannel> {
    if (this.#closed) throw new Error("Agent event ingestor is closed");
    if (this.#channels.has(request.executionGrant)) {
      throw new Error("ExecutionGrant already has an open FactChannel");
    }
    let channel!: RemoteFactChannel;
    channel = new RemoteFactChannel({
      url: this.#url,
      authorization: this.#authorization,
      request,
      onClose: () => this.#channels.delete(request.executionGrant),
    });
    this.#channels.set(request.executionGrant, channel);
    try {
      await channel.open();
      return channel;
    } catch (error: unknown) {
      channel.abort();
      throw error;
    }
  }

  resolve(executionGrant: string): PiSessionMutationFactChannel | undefined {
    return this.#channels.get(executionGrant);
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
    await Promise.allSettled([...this.#channels.values()].map((channel) => channel.close()));
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
