export type ControlToolQuiescence = { active: number; unsettled: number };

/** A temporary local publication hold, never an execution lease or persisted queue. */
export class ControlPlaneQuiescence {
  #active = 0;
  #closed = false;
  #stopping = false;
  #request: { id: string; expiresAt: number; held: boolean } | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #waiters = new Set<() => void>();
  constructor(
    readonly instanceId: string,
    readonly tools: () => ControlToolQuiescence,
    readonly holdMs = 30_000,
  ) {}

  get held(): boolean {
    this.#refresh();
    return this.#request?.held === true;
  }

  #refresh(): void {
    if (!this.#request) return;
    if (Date.now() >= this.#request.expiresAt) {
      this.cancel(this.#request.id);
      return;
    }
    const tools = this.tools();
    if (!this.#active && !tools.active && !tools.unsettled) this.#request.held = true;
  }

  status() {
    this.#refresh();
    return {
      version: 1 as const,
      instanceId: this.instanceId,
      phase: this.#closed
        ? "closed"
        : this.#request?.held
          ? "held"
          : this.#request
            ? "waiting"
            : "open",
      requestId: this.#request?.id ?? null,
      expiresAt: this.#request?.expiresAt ?? null,
      activeProjections: this.#active,
      parkedProjections: this.#waiters.size,
      controlTools: this.tools(),
    };
  }

  prepare(id: string) {
    if (this.#closed || this.#stopping) throw new Error("Control Plane is closing");
    this.#refresh();
    if (this.#request && this.#request.id !== id) throw new Error("Another replacement is pending");
    this.#request ??= { id, expiresAt: 0, held: false };
    this.#request.expiresAt = Date.now() + this.holdMs;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#refresh(), this.holdMs);
    this.#timer.unref();
    return this.status();
  }

  cancel(id: string): void {
    if (this.#stopping && !this.#closed) return;
    if (this.#request?.id !== id) return;
    clearTimeout(this.#timer);
    this.#request = undefined;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.held) await new Promise<void>((resolve) => this.#waiters.add(resolve));
    // A stopped handler must reject: returning success would acknowledge an
    // unprojected record. Existing Kafka ownership checks handle the rejection.
    if (this.#closed) throw new Error("Control Plane projection has stopped");
    this.#active++;
    try {
      return await operation();
    } finally {
      this.#active--;
      this.#refresh();
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#request) this.cancel(this.#request.id);
  }

  async beforeShutdown(): Promise<void> {
    // Recheck at the actual signal, even if an earlier operator hold expired
    // while a Kubernetes request was delayed. No late scale may bypass this.
    if (this.#closed) return;
    if (!this.#stopping) {
      this.#stopping = true;
      clearTimeout(this.#timer);
      this.#request = { id: "process-stop", expiresAt: Infinity, held: false };
    }
    while (!this.#closed && !this.held) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
