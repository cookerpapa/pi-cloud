import type {
  PiCloudEvent,
  ToolProgress,
  RunObservation,
  InputQueueResource,
} from "@pi-cloud/protocol";
import { ToolPreviewChannel, SESSION_STREAM_PART_CHARACTERS } from "@pi-cloud/protocol";
import { stringifyChunked } from "@discoveryjs/json-ext";

export const SESSION_EVENT_PENDING_BYTES = 16 * 1024 * 1024;

export type SessionEventWake = {
  throughSequence: number | null;
  event?: PiCloudEvent;
  progress?: ToolProgress;
  observation?: RunObservation;
  inputQueue?: InputQueueResource;
};

type PendingRead = {
  resolve: (wake: SessionEventWake | undefined) => void;
};

export class SessionEventSubscription {
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #onClose: (subscription: SessionEventSubscription) => void;
  #queuedWakes: { wake: SessionEventWake; bytes: number }[] = [];
  #queuedBytes = 0;
  #resync = false;
  #pendingRead: PendingRead | undefined;
  #closed = false;
  readonly #progress = new Map<string, { header: ToolProgress; channel: ToolPreviewChannel }>();
  readonly #observations = new Map<string, RunObservation>();
  #inputQueue: InputQueueResource | undefined;

  constructor(
    tenantId: string,
    sessionId: string,
    onClose: (subscription: SessionEventSubscription) => void,
    readonly maximumPendingBytes = SESSION_EVENT_PENDING_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumPendingBytes) || maximumPendingBytes < 1)
      throw new TypeError("Invalid pending Session event byte budget");
    this.#tenantId = tenantId;
    this.#sessionId = sessionId;
    this.#onClose = onClose;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  notifyEvent(event: PiCloudEvent, encodedBytes: () => number): void {
    if (this.#closed || this.#resync) return;
    if (event.sessionId !== this.#sessionId) {
      throw new TypeError("Session event wake belongs to a different Session");
    }
    if (
      event.type === "tool.completed" ||
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
    )
      for (const [id, preview] of this.#progress)
        if (
          preview.header.turnId === event.turnId &&
          (event.type !== "tool.completed" ||
            preview.header.toolCallId === event.payload.toolCallId)
        )
          this.#progress.delete(id);
    this.#push(event, encodedBytes);
  }

  notifyProgress(progress: ToolProgress): void {
    if (this.#closed || this.#resync) return;
    if (progress.sessionId !== this.#sessionId)
      throw new Error("Tool progress belongs to another Session");
    let preview = this.#progress.get(progress.operationId);
    if (!preview) {
      if (this.#progress.size >= 64 && !this.#progress.has(progress.operationId))
        this.#progress.delete(this.#progress.keys().next().value!);
      preview = { header: progress, channel: new ToolPreviewChannel() };
      this.#progress.set(progress.operationId, preview);
    } else if (
      preview.header.turnId !== progress.turnId ||
      preview.header.toolCallId !== progress.toolCallId
    )
      return;
    try {
      if (!preview.channel.accept(progress.update)) return;
    } catch {
      return;
    }
    preview.header = progress;
    if (this.#pendingRead) {
      const update = preview.channel.take();
      if (!update) return;
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve({ throughSequence: null, progress: { ...progress, update } });
    }
  }

  forgetProgress(operationId: string): void {
    this.#progress.delete(operationId);
  }

  notifyObservation(observation: RunObservation): void {
    if (this.#closed || this.#resync) return;
    if (this.#pendingRead) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve({ throughSequence: null, observation });
      return;
    }
    const key = `${observation.turnId}\0${observation.type}`;
    for (const pending of this.#observations.values())
      if (pending.turnId === observation.turnId && pending.generation > observation.generation)
        return;
    for (const [id, pending] of this.#observations)
      if (pending.turnId === observation.turnId && pending.generation < observation.generation)
        this.#observations.delete(id);
    const previous = this.#observations.get(key);
    const position = (value: RunObservation) =>
      value.type === "run.path" ? value.sentAt : value.revision;
    if (previous && position(previous) >= position(observation)) return;
    if (this.#observations.size >= 64 && !this.#observations.has(key))
      this.#observations.delete(this.#observations.keys().next().value!);
    this.#observations.set(key, observation);
  }

  resync(): void {
    if (this.#closed || this.#resync) return;
    this.#resync = true;
    this.#clearPending();
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    if (pending) pending.resolve({ throughSequence: null });
    else this.#queuedWakes.push({ wake: { throughSequence: null }, bytes: 0 });
  }

  #clearPending(): void {
    this.#queuedWakes = [];
    this.#queuedBytes = 0;
    this.#progress.clear();
    this.#observations.clear();
    this.#inputQueue = undefined;
  }

  #push(event: PiCloudEvent, encodedBytes: () => number): void {
    const wake = { throughSequence: event.seq, event };
    if (this.#pendingRead !== undefined) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve(wake);
      return;
    }
    if (this.#queuedWakes.length >= 1_024) {
      this.resync();
      return;
    }
    const bytes = encodedBytes();
    if (this.#queuedBytes + bytes > this.maximumPendingBytes) {
      this.resync();
      return;
    }
    this.#queuedBytes += bytes;
    this.#queuedWakes.push({ wake, bytes });
  }

  next(): Promise<SessionEventWake | undefined>;
  next(heartbeatMs: number): Promise<SessionEventWake | "heartbeat" | undefined>;
  next(heartbeatMs?: number): Promise<SessionEventWake | "heartbeat" | undefined> {
    const queued = this.#queuedWakes.shift();
    if (queued !== undefined) {
      this.#queuedBytes -= queued.bytes;
      return Promise.resolve(queued.wake);
    }
    if (this.#closed || this.#resync) return Promise.resolve(undefined);
    if (this.#inputQueue) {
      const inputQueue = this.#inputQueue;
      this.#inputQueue = undefined;
      return Promise.resolve({ throughSequence: null, inputQueue });
    }
    const observation = this.#observations.entries().next().value;
    if (observation) {
      this.#observations.delete(observation[0]);
      return Promise.resolve({ throughSequence: null, observation: observation[1] });
    }
    for (const preview of this.#progress.values()) {
      const update = preview.channel.take();
      if (update)
        return Promise.resolve({ throughSequence: null, progress: { ...preview.header, update } });
    }
    if (this.#pendingRead !== undefined) {
      throw new Error("Only one pending session-event read is allowed");
    }
    return new Promise<SessionEventWake | "heartbeat" | undefined>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (wake: SessionEventWake | "heartbeat" | undefined) => {
        clearTimeout(timer);
        resolve(wake);
      };
      const pending = { resolve: settle };
      this.#pendingRead = pending;
      if (heartbeatMs !== undefined) {
        timer = setTimeout(() => {
          if (this.#pendingRead !== pending) return;
          this.#pendingRead = undefined;
          settle("heartbeat");
        }, heartbeatMs);
        timer.unref();
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearPending();
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    pending?.resolve(undefined);
    this.#onClose(this);
  }

  notifyInputQueue(inputQueue: InputQueueResource): void {
    if (this.#closed || this.#resync) return;
    if (inputQueue.sessionId !== this.#sessionId)
      throw new Error("Input queue belongs to another Session");
    if (this.#inputQueue && BigInt(this.#inputQueue.viewVersion) > BigInt(inputQueue.viewVersion))
      return;
    if (this.#pendingRead) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve({ throughSequence: null, inputQueue });
    } else this.#inputQueue = inputQueue;
  }
}

export class SessionEventHub {
  readonly #subscriptions = new Map<string, Set<SessionEventSubscription>>();

  constructor(readonly maximumPendingBytes = SESSION_EVENT_PENDING_BYTES) {
    if (!Number.isSafeInteger(maximumPendingBytes) || maximumPendingBytes < 1)
      throw new TypeError("Invalid pending Session event byte budget");
  }

  subscribe(tenantId: string, sessionId: string): SessionEventSubscription {
    const key = this.#key(tenantId, sessionId);
    const subscription = new SessionEventSubscription(
      tenantId,
      sessionId,
      (closed) => this.#remove(closed),
      this.maximumPendingBytes,
    );
    const current = this.#subscriptions.get(key);
    if (current === undefined) {
      this.#subscriptions.set(key, new Set([subscription]));
    } else {
      current.add(subscription);
    }
    return subscription;
  }

  publish(tenantId: string, event: PiCloudEvent): void {
    const current = this.#subscriptions.get(this.#key(tenantId, event.sessionId));
    if (current === undefined) return;
    // Count only when a reader actually queues this event, once for this broadcast.
    // Retain numbers/references in queues, not an extra serialized body per viewer.
    let bytes: number | undefined;
    const encodedBytes = () => {
      if (bytes === undefined) {
        bytes = 0;
        for (const chunk of stringifyChunked(event, {
          highWaterMark: SESSION_STREAM_PART_CHARACTERS,
        })) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > this.maximumPendingBytes) break;
        }
      }
      return bytes;
    };
    for (const subscription of [...current]) subscription.notifyEvent(event, encodedBytes);
  }

  publishProgress(tenantId: string, progress: ToolProgress): void {
    for (const subscription of this.#subscriptions.get(this.#key(tenantId, progress.sessionId)) ??
      [])
      subscription.notifyProgress(progress);
  }

  publishObservation(tenantId: string, observation: RunObservation): void {
    for (const subscription of this.#subscriptions.get(
      this.#key(tenantId, observation.sessionId),
    ) ?? [])
      subscription.notifyObservation(observation);
  }
  hasSubscribers(tenant: string, session: string): boolean {
    return (this.#subscriptions.get(this.#key(tenant, session))?.size ?? 0) > 0;
  }
  publishInputQueue(tenant: string, queue: InputQueueResource): void {
    for (const subscriber of this.#subscriptions.get(this.#key(tenant, queue.sessionId)) ?? [])
      subscriber.notifyInputQueue(queue);
  }
  resyncSession(tenant: string, session: string): void {
    for (const subscriber of this.#subscriptions.get(this.#key(tenant, session)) ?? [])
      subscriber.resync();
  }

  resyncAll(): void {
    for (const current of this.#subscriptions.values()) {
      for (const subscription of [...current]) subscription.resync();
    }
  }

  onApplicationShutdown(): void {
    const subscriptions = [...this.#subscriptions.values()].flatMap((current) => [...current]);
    for (const subscription of subscriptions) subscription.close();
    this.#subscriptions.clear();
  }

  #remove(subscription: SessionEventSubscription): void {
    const key = this.#key(subscription.tenantId, subscription.sessionId);
    const current = this.#subscriptions.get(key);
    if (current === undefined) return;
    current.delete(subscription);
    if (current.size === 0) this.#subscriptions.delete(key);
  }

  #key(tenantId: string, sessionId: string): string {
    if (tenantId.includes("\0") || sessionId.includes("\0")) {
      throw new TypeError("Tenant and session identities must not contain NUL bytes");
    }
    return `${tenantId}\0${sessionId}`;
  }
}
