import type { PiCloudEvent } from "@pi-cloud/protocol";

export type SessionEventWake = {
  throughSequence: number | null;
  event?: PiCloudEvent;
};

type PendingRead = {
  resolve: (wake: SessionEventWake | undefined) => void;
};

export class SessionEventSubscription {
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #onClose: (subscription: SessionEventSubscription) => void;
  #queuedWakes: SessionEventWake[] = [];
  #pendingRead: PendingRead | undefined;
  #closed = false;

  constructor(
    tenantId: string,
    sessionId: string,
    onClose: (subscription: SessionEventSubscription) => void,
  ) {
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

  notifyThrough(throughSequence: number): void {
    if (this.#closed) return;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) {
      throw new TypeError("throughSequence must be a positive safe integer");
    }
    this.#push({ throughSequence });
  }

  notifyEvent(event: PiCloudEvent): void {
    if (this.#closed) return;
    if (event.sessionId !== this.#sessionId) {
      throw new TypeError("Session event wake belongs to a different Session");
    }
    this.#push({ throughSequence: event.seq, event });
  }

  resync(): void {
    if (this.#closed) return;
    this.#push({ throughSequence: null });
  }

  #push(wake: SessionEventWake): void {
    if (this.#pendingRead !== undefined) {
      const pending = this.#pendingRead;
      this.#pendingRead = undefined;
      pending.resolve(wake);
      return;
    }
    if (wake.throughSequence === null) {
      this.#queuedWakes = [{ throughSequence: null }];
      return;
    }
    if (this.#queuedWakes.some((queued) => queued.throughSequence === null)) return;
    if (this.#queuedWakes.length >= 1_024) {
      this.#queuedWakes = [{ throughSequence: null }];
      return;
    }
    this.#queuedWakes.push(wake);
  }

  next(): Promise<SessionEventWake | undefined> {
    const wake = this.#queuedWakes.shift();
    if (wake !== undefined) return Promise.resolve(wake);
    if (this.#closed) return Promise.resolve(undefined);
    if (this.#pendingRead !== undefined) {
      throw new Error("Only one pending session-event read is allowed");
    }
    return new Promise<SessionEventWake | undefined>((resolve) => {
      this.#pendingRead = { resolve };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queuedWakes = [];
    const pending = this.#pendingRead;
    this.#pendingRead = undefined;
    pending?.resolve(undefined);
    this.#onClose(this);
  }
}

export class SessionEventHub {
  readonly #subscriptions = new Map<string, Set<SessionEventSubscription>>();

  subscribe(tenantId: string, sessionId: string): SessionEventSubscription {
    const key = this.#key(tenantId, sessionId);
    const subscription = new SessionEventSubscription(tenantId, sessionId, (closed) =>
      this.#remove(closed),
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
    for (const subscription of [...current]) subscription.notifyEvent(event);
  }

  notifyThrough(tenantId: string, sessionId: string, throughSequence: number): void {
    const current = this.#subscriptions.get(this.#key(tenantId, sessionId));
    if (current === undefined) return;
    for (const subscription of [...current]) subscription.notifyThrough(throughSequence);
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
