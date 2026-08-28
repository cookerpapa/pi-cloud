import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventAckMessage,
  type EventPublishMessage,
  type FactChannelOpenMessage,
} from "@pi-cloud/protocol";
import {
  ExecutionLeaseAuthorityGateError,
  PostgresExecutionLeaseAuthorityGate,
} from "./session-lease-authority-gate.ts";
import { performance } from "node:perf_hooks";
import {
  DurableEventStoreError,
  type FactChannelFactory,
  type FactChannel,
  type FactChannelOpenRequest,
} from "./durable-event-store.ts";
import WebSocket, { type RawData } from "ws";
import type {
  AcceptedFactBus,
  AcceptedFactProgressStore,
  ActiveFactChannelResolver,
  CandidateFact,
  CandidatePiSessionMutationFact,
  PiSessionMutationAcceptedFrame,
  PiSessionMutationFactChannel,
  PiSessionMutationPublishFrame,
} from "./accepted-fact.ts";

function acknowledgement(message: EventPublishMessage): EventAckMessage {
  const parsed = parseControlToSupervisorMessage({
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.ack",
    payload: {
      sessionId: message.payload.event.sessionId,
      executionLease: message.payload.executionLease,
      acknowledgedThroughSeq: message.payload.event.seq,
    },
  });
  if (parsed.type !== "event.ack") throw new Error("Agent event ACK is invalid");
  return parsed;
}

export type AcceptedFactChannelSession = Readonly<{
  executionLease: string;
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
  authority: PostgresExecutionLeaseAuthorityGate;
  bus: AcceptedFactBus;
  progress: AcceptedFactProgressStore;
  instanceId: string;
  leaseDurationMs?: number;
  maximumActiveChannels?: number;
}>;

function factChannelError(error: unknown): DurableEventStoreError {
  if (error instanceof DurableEventStoreError) return error;
  if (error instanceof ExecutionLeaseAuthorityGateError) {
    return new DurableEventStoreError(
      error.code === "fact_channel_conflict"
        ? "event_conflict"
        : error.code === "authority_invariant"
          ? "event_store_invariant"
          : "stale_session_lease",
      error.message,
      error.retryable,
    );
  }
  return new DurableEventStoreError("event_store_invariant", "FactChannel failed", true);
}

class ServerFactChannel implements AcceptedFactChannelSession {
  readonly executionLease: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly #authority: PostgresExecutionLeaseAuthorityGate;
  readonly #bus: AcceptedFactBus;
  readonly #progress: AcceptedFactProgressStore;
  readonly #scope: Awaited<ReturnType<PostgresExecutionLeaseAuthorityGate["open"]>>;
  readonly #ensureLease: () => Promise<void>;
  #acknowledgedThroughSeq: number;
  #leaseDurationMs: number;
  #usableUntil = 0;
  #publishing = false;
  #closed = false;
  #failure: DurableEventStoreError | undefined;

  constructor(options: {
    authority: PostgresExecutionLeaseAuthorityGate;
    bus: AcceptedFactBus;
    progress: AcceptedFactProgressStore;
    scope: Awaited<ReturnType<PostgresExecutionLeaseAuthorityGate["open"]>>;
    acknowledgedThroughSeq: number;
    ensureLease: () => Promise<void>;
  }) {
    this.#authority = options.authority;
    this.#bus = options.bus;
    this.#progress = options.progress;
    this.#scope = options.scope;
    this.#ensureLease = options.ensureLease;
    this.executionLease = options.scope.executionLease;
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

  get authorityScope(): Awaited<ReturnType<PostgresExecutionLeaseAuthorityGate["open"]>> {
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
      message.payload.executionLease !== this.executionLease ||
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
      const recorded = await this.#progress.recordMany([this.eventProgress]);
      if (!recorded.has(this.#scope.connectionId)) {
        throw new ExecutionLeaseAuthorityGateError(
          "stale_session_lease",
          "FactChannel progress could not be recorded under current ownership",
          false,
        );
      }
      await this.#authority.close(this.#scope);
    } catch (error: unknown) {
      throw factChannelError(error);
    }
  }

  get eventProgress() {
    return {
      leaseId: this.#scope.leaseId,
      attemptId: this.#scope.attemptId,
      fencingToken: this.#scope.fencingToken,
      channelConnectionId: this.#scope.connectionId,
      channelInstanceId: this.#scope.instanceId,
      acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
    } as const;
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
      throw new DurableEventStoreError("stale_session_lease", "FactChannel lease expired");
    }
  }
}

export class FactChannelService {
  readonly #authority: PostgresExecutionLeaseAuthorityGate;
  readonly #bus: AcceptedFactBus;
  readonly #progress: AcceptedFactProgressStore;
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
    this.#progress = options.progress;
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
    let scope: Awaited<ReturnType<PostgresExecutionLeaseAuthorityGate["open"]>>;
    try {
      scope = await this.#authority.open(
        {
          executionLease: message.payload.executionLease,
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
      progress: this.#progress,
      scope,
      acknowledgedThroughSeq: message.payload.nextEventSeq - 1,
      ensureLease: () => this.#renewIfDue(false),
    });
    this.#channels.set(scope.connectionId, { channel, onFailure });
    this.#scheduleRenewal();
    let closed = false;
    return {
      executionLease: channel.executionLease,
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
      let recorded: ReadonlySet<string>;
      try {
        const progress = chunk
          .filter(({ channel }) => renewed.has(channel.authorityScope.connectionId))
          .map(({ channel }) => channel.eventProgress);
        recorded = progress.length === 0 ? new Set() : await this.#progress.recordMany(progress);
      } catch (error: unknown) {
        for (const entry of chunk) this.#failChannel(entry, error);
        continue;
      }
      for (const entry of chunk) {
        if (entry.channel.closed) continue;
        const durationMs = renewed.get(entry.channel.authorityScope.connectionId);
        if (durationMs === undefined || !recorded.has(entry.channel.authorityScope.connectionId)) {
          this.#failChannel(
            entry,
            new ExecutionLeaseAuthorityGateError(
              "stale_session_lease",
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

export type FactTransportEnvelope = Readonly<{
  protocolVersion: 1;
  streamId: string;
  payload: unknown;
}>;

export type FactStreamFailureFrame = Readonly<{
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "fact.stream.failed";
  payload: Readonly<{ code: string; message: string; retryable: boolean }>;
}>;

export function factTransportEnvelope(streamId: string, payload: unknown): FactTransportEnvelope {
  return { protocolVersion: 1, streamId, payload };
}

export function parseFactTransportEnvelope(value: unknown): FactTransportEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    typeof (value as { streamId?: unknown }).streamId !== "string" ||
    (value as { streamId: string }).streamId.length === 0 ||
    (value as { payload?: unknown }).payload === undefined
  ) {
    throw new DurableEventStoreError("invalid_event", "Multiplexed Fact frame is invalid");
  }
  return value as FactTransportEnvelope;
}

export function factStreamFailureFrame(error: unknown): FactStreamFailureFrame {
  const failure = factChannelError(error);
  return {
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "fact.stream.failed",
    payload: { code: failure.code, message: failure.message, retryable: failure.retryable },
  };
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

function remoteFactResponse(value: unknown): RemoteFactChannelResponse | FactStreamFailureFrame {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "fact.stream.failed"
  ) {
    const frame = value as FactStreamFailureFrame;
    if (
      typeof frame.payload?.code !== "string" ||
      typeof frame.payload.message !== "string" ||
      typeof frame.payload.retryable !== "boolean"
    ) {
      throw new Error("Fact Stream failure frame is invalid");
    }
    return frame;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "fact.pi_session_mutation.accepted"
  ) {
    return value as PiSessionMutationAcceptedFrame;
  }
  return parseControlToSupervisorMessage(value);
}

function remoteStreamError(frame: FactStreamFailureFrame): DurableEventStoreError {
  const code = [
    "not_found",
    "invalid_event",
    "event_conflict",
    "sequence_gap",
    "stale_session_lease",
    "event_store_invariant",
  ].includes(frame.payload.code)
    ? (frame.payload.code as ConstructorParameters<typeof DurableEventStoreError>[0])
    : "event_store_invariant";
  return new DurableEventStoreError(code, frame.payload.message, frame.payload.retryable);
}

class WorkerFactTransport {
  readonly #url: URL;
  readonly #authorization: string;
  readonly #pending = new Map<string, PendingRemoteExchange>();
  readonly #streamFailures = new Map<string, (error: DurableEventStoreError) => void>();
  #socket: WebSocket | undefined;
  #connecting: Promise<number | undefined> | undefined;
  #generation = 0;
  #closed = false;

  constructor(options: { url: URL; authorization: string }) {
    this.#url = options.url;
    this.#authorization = options.authorization;
  }

  register(streamId: string, onFailure: (error: DurableEventStoreError) => void): void {
    if (this.#closed || this.#streamFailures.has(streamId)) {
      throw new Error("Fact Stream identity is unavailable");
    }
    this.#streamFailures.set(streamId, onFailure);
  }

  unregister(streamId: string): void {
    this.#streamFailures.delete(streamId);
    const pending = this.#pending.get(streamId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(streamId);
    pending.settle({ error: new Error("Fact Stream closed") });
  }

  async ensureConnected(deadline: number): Promise<number | undefined> {
    if (this.#closed) return undefined;
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#generation;
    if (this.#connecting === undefined) {
      const connecting = this.#connect(deadline).finally(() => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      });
      void connecting.catch(() => undefined);
      this.#connecting = connecting;
    }
    return this.#connecting;
  }

  exchange(
    streamId: string,
    message: unknown,
    expectedType: PendingRemoteExchange["expectedType"],
    deadline: number,
  ): Promise<{ message: RemoteFactChannelResponse } | { error: Error }> {
    if (this.#pending.has(streamId)) {
      return Promise.resolve({
        error: new DurableEventStoreError(
          "event_conflict",
          "Fact Stream already has an in-flight frame",
          true,
        ),
      });
    }
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: new Error("Worker Fact connection is not open") });
    }
    return new Promise<{ message: RemoteFactChannelResponse } | { error: Error }>((settle) => {
      const timer = setTimeout(
        () => {
          if (this.#pending.get(streamId)?.timer !== timer) return;
          this.#pending.delete(streamId);
          settle({ error: new Error("Fact Stream frame timed out") });
        },
        Math.max(1, Math.min(60_000, deadline - Date.now())),
      );
      this.#pending.set(streamId, { expectedType, settle, timer });
      socket.send(JSON.stringify(factTransportEnvelope(streamId, message)), (error) => {
        if (error == null || this.#pending.get(streamId)?.timer !== timer) return;
        clearTimeout(timer);
        this.#pending.delete(streamId);
        settle({ error });
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetSocket(new Error("Worker Fact connection closed"));
    this.#streamFailures.clear();
  }

  async #connect(deadline: number): Promise<number | undefined> {
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
      return undefined;
    }
    socket.on("message", (data, isBinary) => this.#receive(data, isBinary));
    socket.once("close", () => {
      if (this.#socket === socket) this.#resetSocket(new Error("Worker Fact connection closed"));
    });
    socket.once("error", (error) => {
      if (this.#socket === socket) this.#resetSocket(error);
    });
    this.#generation += 1;
    return this.#generation;
  }

  #receive(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#resetSocket(new Error("Worker Fact connection received a binary frame"));
      return;
    }
    let envelope: FactTransportEnvelope;
    let response: RemoteFactChannelResponse | FactStreamFailureFrame;
    try {
      envelope = parseFactTransportEnvelope(JSON.parse(remoteTextFrame(data)));
      response = remoteFactResponse(envelope.payload);
    } catch (error: unknown) {
      this.#resetSocket(
        error instanceof Error ? error : new Error("Invalid multiplexed Fact frame"),
      );
      return;
    }
    const pending = this.#pending.get(envelope.streamId);
    if (response.type === "fact.stream.failed") {
      const failure = remoteStreamError(response);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(envelope.streamId);
        pending.settle({ error: failure });
      }
      this.#streamFailures.get(envelope.streamId)?.(failure);
      return;
    }
    if (pending === undefined) return;
    if (response.type !== pending.expectedType) {
      clearTimeout(pending.timer);
      this.#pending.delete(envelope.streamId);
      pending.settle({ error: new Error("Fact Stream response type is invalid") });
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(envelope.streamId);
    pending.settle({ message: response });
  }

  #resetSocket(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.settle({ error });
    }
    this.#pending.clear();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

class RemoteFactChannel implements FactChannel {
  readonly #transport: WorkerFactTransport;
  readonly #streamId: string;
  readonly #request: FactChannelOpenRequest;
  readonly #onClose: () => void;
  #operationTail = Promise.resolve();
  #acknowledgedThroughSeq: number;
  #openedGeneration = 0;
  #failure: DurableEventStoreError | undefined;
  #closed = false;

  constructor(options: {
    transport: WorkerFactTransport;
    streamId: string;
    request: FactChannelOpenRequest;
    onClose: () => void;
  }) {
    this.#transport = options.transport;
    this.#streamId = options.streamId;
    this.#request = options.request;
    this.#onClose = options.onClose;
    this.#acknowledgedThroughSeq = options.request.nextEventSeq - 1;
    this.#transport.register(this.#streamId, (error) => {
      this.#openedGeneration = 0;
      if (!error.retryable) this.#failure = error;
    });
  }

  get acknowledgedThroughSeq(): number {
    return this.#acknowledgedThroughSeq;
  }

  async open(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await this.#ensureOpened(deadline)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Fact Stream could not open its transport",
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
    this.#assertOpen();
    const frame: PiSessionMutationPublishFrame = {
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "fact.pi_session_mutation.publish",
      payload: mutation,
    };
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!(await this.#ensureOpened(deadline))) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const exchanged = await this.#transport.exchange(
        this.#streamId,
        frame,
        "fact.pi_session_mutation.accepted",
        deadline,
      );
      if ("error" in exchanged) {
        this.#openedGeneration = 0;
        if (exchanged.error instanceof DurableEventStoreError && !exchanged.error.retryable) {
          throw exchanged.error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
      this.#openedGeneration = 0;
    }
    throw new DurableEventStoreError(
      "event_store_invariant",
      "Fact Stream mutation acceptance timed out",
      true,
    );
  }

  ingest(value: unknown): Promise<EventAckMessage> {
    return this.#serialize(() => this.#ingest(value));
  }

  async #ingest(value: unknown): Promise<EventAckMessage> {
    this.#assertOpen();
    const message = parseSupervisorToControlMessage(value);
    if (
      message.type !== "event.publish" ||
      message.payload.executionLease !== this.#request.executionLease ||
      message.payload.event.sessionId !== this.#request.sessionId ||
      message.payload.event.turnId !== this.#request.turnId
    ) {
      throw new DurableEventStoreError(
        "invalid_event",
        "Event publication does not match its remote Fact Stream",
      );
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!(await this.#ensureOpened(deadline))) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const exchanged = await this.#transport.exchange(
        this.#streamId,
        message,
        "event.ack",
        deadline,
      );
      if ("error" in exchanged) {
        this.#openedGeneration = 0;
        if (exchanged.error instanceof DurableEventStoreError && !exchanged.error.retryable) {
          throw exchanged.error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const response = exchanged.message;
      if (
        response.type !== "event.ack" ||
        response.payload.executionLease !== this.#request.executionLease ||
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
    }
    throw new DurableEventStoreError("event_store_invariant", "Fact Stream is unavailable", true);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#operationTail;
    const deadline = Date.now() + 30_000;
    let failure: unknown;
    try {
      while (Date.now() < deadline) {
        if (!(await this.#ensureOpened(deadline))) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const closeMessage = parseSupervisorToControlMessage({
          protocolVersion: 1,
          messageId: globalThis.crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          type: "fact.channel.close",
          payload: {
            executionLease: this.#request.executionLease,
            acknowledgedThroughSeq: this.#acknowledgedThroughSeq,
          },
        });
        const exchanged = await this.#transport.exchange(
          this.#streamId,
          closeMessage,
          "fact.channel.closed",
          deadline,
        );
        if ("error" in exchanged) {
          failure = exchanged.error;
          this.#openedGeneration = 0;
          if (exchanged.error instanceof DurableEventStoreError && !exchanged.error.retryable) {
            throw exchanged.error;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const response = exchanged.message;
        if (
          response.type !== "fact.channel.closed" ||
          response.payload.acknowledgedMessageId !== closeMessage.messageId ||
          response.payload.executionLease !== this.#request.executionLease ||
          response.payload.acknowledgedThroughSeq !== this.#acknowledgedThroughSeq
        ) {
          throw new DurableEventStoreError(
            "invalid_event",
            "Remote Fact Stream close ACK is invalid",
          );
        }
        failure = undefined;
        return;
      }
      throw factChannelError(failure);
    } finally {
      this.#closed = true;
      this.#transport.unregister(this.#streamId);
      this.#onClose();
    }
  }

  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.unregister(this.#streamId);
    this.#onClose();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #ensureOpened(deadline: number): Promise<boolean> {
    this.#assertOpen();
    const generation = await this.#transport.ensureConnected(deadline);
    if (generation === undefined) return false;
    if (this.#openedGeneration === generation) return true;
    const openMessage = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "fact.channel.open",
      payload: this.#request,
    });
    const exchanged = await this.#transport.exchange(
      this.#streamId,
      openMessage,
      "fact.channel.ready",
      deadline,
    );
    if ("error" in exchanged) {
      if (exchanged.error instanceof DurableEventStoreError && !exchanged.error.retryable) {
        throw exchanged.error;
      }
      return false;
    }
    const response = exchanged.message;
    if (
      response.type !== "fact.channel.ready" ||
      response.payload.acknowledgedMessageId !== openMessage.messageId ||
      response.payload.executionLease !== this.#request.executionLease ||
      response.payload.sessionId !== this.#request.sessionId ||
      response.payload.turnId !== this.#request.turnId
    ) {
      return false;
    }
    this.#acknowledgedThroughSeq = Math.max(
      this.#acknowledgedThroughSeq,
      response.payload.acknowledgedThroughSeq,
    );
    this.#openedGeneration = generation;
    return true;
  }

  #assertOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new DurableEventStoreError("invalid_event", "Fact Stream is closed");
  }
}

export class WebSocketAcceptedFactIngestor
  implements FactChannelFactory, ActiveFactChannelResolver
{
  readonly #authorization: string;
  readonly #healthUrl: URL;
  readonly #transport: WorkerFactTransport;
  readonly #channels = new Map<string, RemoteFactChannel>();
  #closed = false;

  constructor(options: { baseUrl: string; serviceToken: string; allowInsecureHttp: boolean }) {
    this.#authorization = `Bearer ${options.serviceToken}`;
    this.#healthUrl = new URL(`${ACCEPTED_FACT_INGEST_PATH}/health`, options.baseUrl);
    this.#transport = new WorkerFactTransport({
      url: factChannelUrl(options.baseUrl, options.allowInsecureHttp),
      authorization: this.#authorization,
    });
  }

  async open(request: FactChannelOpenRequest): Promise<FactChannel> {
    if (this.#closed) throw new Error("Agent event ingestor is closed");
    if (this.#channels.has(request.executionLease)) {
      throw new Error("ExecutionLease already has an open Fact Stream");
    }
    let channel!: RemoteFactChannel;
    channel = new RemoteFactChannel({
      transport: this.#transport,
      streamId: globalThis.crypto.randomUUID(),
      request,
      onClose: () => this.#channels.delete(request.executionLease),
    });
    this.#channels.set(request.executionLease, channel);
    try {
      await channel.open();
      return channel;
    } catch (error: unknown) {
      channel.abort();
      throw error;
    }
  }

  resolve(executionLease: string): PiSessionMutationFactChannel | undefined {
    return this.#channels.get(executionLease);
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
    this.#transport.close();
  }
}
