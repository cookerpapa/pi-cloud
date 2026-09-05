import type {
  ConversationDetailResource,
  PiCloudEvent,
  SessionViewSnapshotResource,
} from "@pi-cloud/protocol";
import type { ServerResponse } from "node:http";
import type { LiveSessionTailSnapshot } from "./kafka-live-session-tail.ts";
import { SessionEventHub, type SessionEventSubscription } from "./session-event-hub.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export type SessionEventStreamOptions = Readonly<{
  heartbeatIntervalMs?: number;
}>;

export interface LiveSessionTailSource {
  snapshot(tenantId: string, sessionId: string): LiveSessionTailSnapshot;
}

export type CanonicalSessionView = Readonly<{
  conversation: ConversationDetailResource;
  canonicalThroughSequence: number;
}>;

function snapshotFrame(snapshot: SessionViewSnapshotResource): string {
  return `event: session.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

function eventFrame(event: PiCloudEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function writeChunk(response: ServerResponse, chunk: string): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const settle = (writable: boolean): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(writable);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const onError = (): void => settle(false);
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
  readonly #snapshot: SessionViewSnapshotResource;
  readonly #highWaterMark: number;
  readonly #heartbeatIntervalMs: number;

  constructor(options: {
    subscription: SessionEventSubscription;
    snapshot: SessionViewSnapshotResource;
    highWaterMark: number;
    heartbeatIntervalMs: number;
  }) {
    this.#subscription = options.subscription;
    this.#snapshot = options.snapshot;
    this.#highWaterMark = options.highWaterMark;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
  }

  async pipe(response: ServerResponse): Promise<void> {
    let lastSentSequence = this.#highWaterMark;
    const close = (): void => this.#subscription.close();
    response.once("close", close);
    try {
      if (!(await writeChunk(response, snapshotFrame(this.#snapshot)))) return;
      let pending = this.#subscription.next();
      while (!response.destroyed && !response.writableEnded) {
        const item = await nextWithHeartbeat(pending, this.#heartbeatIntervalMs);
        if (item === "heartbeat") {
          if (!(await writeChunk(response, ": keepalive\n\n"))) return;
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
        if (!(await writeChunk(response, eventFrame(event)))) return;
        lastSentSequence = event.seq;
      }
    } finally {
      response.off("close", close);
      this.#subscription.close();
    }
  }
}

export class SessionEventStream {
  readonly #tails: LiveSessionTailSource;
  readonly #hub: SessionEventHub;
  readonly #heartbeatIntervalMs: number;

  constructor(
    tails: LiveSessionTailSource,
    hub: SessionEventHub,
    options: SessionEventStreamOptions = {},
  ) {
    this.#tails = tails;
    this.#hub = hub;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#heartbeatIntervalMs) || this.#heartbeatIntervalMs < 1) {
      throw new TypeError("heartbeatIntervalMs must be a positive safe integer");
    }
  }

  async open(options: {
    tenantId: string;
    sessionId: string;
    loadCanonical(): Promise<CanonicalSessionView>;
  }): Promise<OpenSessionEventStream> {
    const subscription = this.#hub.subscribe(options.tenantId, options.sessionId);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const canonical = await options.loadCanonical();
        const tail = this.#tails.snapshot(options.tenantId, options.sessionId);
        if (tail.canonicalThroughSequence > canonical.canonicalThroughSequence) continue;
        const liveEvents = tail.events.filter(
          (event) => event.seq > canonical.canonicalThroughSequence,
        );
        return new OpenSessionEventStream({
          subscription,
          snapshot: { schemaVersion: 1, conversation: canonical.conversation, liveEvents },
          highWaterMark:
            liveEvents.at(-1)?.seq ??
            Math.max(canonical.canonicalThroughSequence, tail.canonicalThroughSequence),
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
        });
      }
      throw new Error("Canonical Session view did not catch up with its committed Kafka tail");
    } catch (error: unknown) {
      subscription.close();
      throw error;
    }
  }
}
