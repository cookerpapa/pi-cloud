import type { ConversationDetailResource, SessionViewSnapshotResource } from "@pi-cloud/protocol";
import type { ServerResponse } from "node:http";
import type { LiveSessionTailSnapshot } from "./session-live-view.ts";
import { SessionEventHub, type SessionEventSubscription } from "./session-event-hub.ts";
import { SESSION_STREAM_SEND_TIMEOUT_MS } from "@pi-cloud/protocol";
import { sessionJsonFrames } from "./session-stream-framing.ts";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import { setImmediate as yieldToIo } from "node:timers/promises";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export type SessionEventStreamOptions = Readonly<{
  heartbeatIntervalMs?: number;
  sendTimeoutMs?: number;
}>;

export interface LiveSessionTailSource {
  owner?(tenantId: string, sessionId: string): Promise<string | undefined>;
  waitForSession?(tenantId: string, sessionId: string): Promise<void>;
  snapshot(tenantId: string, sessionId: string): LiveSessionTailSnapshot;
}

export type CanonicalSessionView = Readonly<{
  conversation: ConversationDetailResource;
  canonicalThroughSequence: number;
}>;

async function writeChunk(
  response: ServerResponse,
  chunk: string,
  timeoutMs: number,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const settle = (writable: boolean): void => {
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(writable);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onError = (): void => settle(false);
    const timer = setTimeout(() => {
      response.destroy();
      settle(false);
    }, timeoutMs);
    timer.unref();
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function nextWithHeartbeat(
  pending: ReturnType<SessionEventSubscription["next"]>,
  heartbeatIntervalMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  const heartbeat = new Promise<"heartbeat">((resolve) => {
    timer = setTimeout(() => resolve("heartbeat"), heartbeatIntervalMs);
    timer.unref();
  });
  try {
    return await Promise.race([pending, heartbeat]);
  } finally {
    clearTimeout(timer);
  }
}

export class OpenSessionEventStream {
  readonly #subscription: SessionEventSubscription;
  #snapshot: SessionViewSnapshotResource | undefined;
  readonly #highWaterMark: number;
  readonly #heartbeatIntervalMs: number;
  readonly #sendTimeoutMs: number;

  constructor(options: {
    subscription: SessionEventSubscription;
    snapshot: SessionViewSnapshotResource;
    highWaterMark: number;
    heartbeatIntervalMs: number;
    sendTimeoutMs?: number;
  }) {
    this.#subscription = options.subscription;
    this.#snapshot = options.snapshot;
    this.#highWaterMark = options.highWaterMark;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? SESSION_STREAM_SEND_TIMEOUT_MS;
  }

  async #sendValue(
    response: ServerResponse,
    value: unknown,
    kind: "snapshot" | "event",
    eventType?: string,
  ) {
    let parts = 0;
    for (const frame of sessionJsonFrames(value, kind, eventType)) {
      if (!(await writeChunk(response, frame, this.#sendTimeoutMs))) return false;
      if (++parts % 16 === 0) await yieldToIo();
    }
    return true;
  }
  async #sendSnapshot(response: ServerResponse) {
    const snapshot = this.#snapshot;
    this.#snapshot = undefined;
    return this.#sendValue(response, snapshot, "snapshot");
  }

  async pipe(response: ServerResponse): Promise<void> {
    let lastSentSequence = this.#highWaterMark;
    const close = (): void => this.#subscription.close();
    response.once("close", close);
    try {
      if (!(await this.#sendSnapshot(response))) return;
      let pending = this.#subscription.next();
      while (!response.destroyed && !response.writableEnded) {
        const item = await nextWithHeartbeat(pending, this.#heartbeatIntervalMs);
        if (item === "heartbeat") {
          if (!(await writeChunk(response, ": keepalive\n\n", this.#sendTimeoutMs))) return;
          continue;
        }
        if (item === undefined) return;
        pending = this.#subscription.next();
        // Queue overflow deliberately asks the browser to reconnect and receive
        // one replacement snapshot instead of pinning shared Gateway memory.
        if (item.throughSequence === null || item.event === undefined) return;
        const event = item.event;
        if (event.seq <= lastSentSequence) continue;
        if (event.seq !== lastSentSequence + 1) return;
        if (!(await this.#sendValue(response, event, "event", event.type))) return;
        lastSentSequence = event.seq;
      }
    } finally {
      response.off("close", close);
      this.#subscription.close();
    }
  }
}

export class SessionEventStream {
  owner(tenantId: string, sessionId: string): Promise<string | undefined> {
    return this.#tails.owner?.(tenantId, sessionId) ?? Promise.resolve(undefined);
  }
  readonly #tails: LiveSessionTailSource;
  readonly #hub: SessionEventHub;
  readonly #heartbeatIntervalMs: number;
  readonly #sendTimeoutMs: number;

  constructor(
    tails: LiveSessionTailSource,
    hub: SessionEventHub,
    options: SessionEventStreamOptions = {},
  ) {
    this.#tails = tails;
    this.#hub = hub;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? SESSION_STREAM_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 1) {
      throw new TypeError("heartbeatIntervalMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#sendTimeoutMs) || this.#sendTimeoutMs < 1)
      throw new TypeError("sendTimeoutMs must be positive");
  }

  async open(options: {
    tenantId: string;
    sessionId: string;
    loadCanonical(): Promise<CanonicalSessionView>;
  }): Promise<OpenSessionEventStream> {
    await this.#tails.waitForSession?.(options.tenantId, options.sessionId);
    const subscription = this.#hub.subscribe(options.tenantId, options.sessionId);
    try {
      // Capture before reading primary PG. The database cannot precede a
      // coverage position already committed and observed in this tail.
      const tail = this.#tails.snapshot(options.tenantId, options.sessionId);
      const canonical = await options.loadCanonical();
      if (tail.canonicalThroughSequence > canonical.canonicalThroughSequence)
        throw new Error("Canonical Session view is behind its committed display coverage");
      const liveEvents = tail.events.filter(
        (event) => event.seq > canonical.canonicalThroughSequence,
      );
      return new OpenSessionEventStream({
        subscription,
        snapshot: {
          schemaVersion: 2,
          conversation: {
            ...canonical.conversation,
            turns: canonical.conversation.turns.map((turn) => {
              const events = liveEvents.filter(
                (event) =>
                  event.turnId === turn.turnId &&
                  event.seq > (turn.transcript?.throughSequence ?? 0),
              );
              return events.length
                ? {
                    ...turn,
                    transcript: projectConversationTurnTranscript(events, turn.transcript),
                  }
                : turn;
            }),
          },
        },
        highWaterMark:
          liveEvents.at(-1)?.seq ??
          Math.max(canonical.canonicalThroughSequence, tail.canonicalThroughSequence),
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        sendTimeoutMs: this.#sendTimeoutMs,
      });
    } catch (error: unknown) {
      subscription.close();
      throw error;
    }
  }
}
