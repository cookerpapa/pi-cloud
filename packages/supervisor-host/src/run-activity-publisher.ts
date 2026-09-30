import {
  RUN_ACTIVITY_PATH,
  RUN_PATH_PROBE_INTERVAL_MS,
  type RunActivityUpdate,
  type RuntimeObservationScope,
} from "@pi-cloud/protocol";

type Active = {
  scope: RuntimeObservationScope;
  partition: number;
  update: RunActivityUpdate;
  revision: number;
  due: number;
};

/** One latest snapshot per active Run, at most four bounded HTTP sends in flight. */
export class RunActivityPublisher {
  readonly #runs = new Map<string, Active>();
  readonly #sending = new Map<string, AbortController>();
  readonly #owners = new Map<number, string>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly send: typeof fetch = fetch,
  ) {
    this.#timer = setInterval(() => this.flush(), 1_000);
    this.#timer.unref();
  }
  update(scope: RuntimeObservationScope, partition: number, update: RunActivityUpdate): void {
    if (this.#closed) return;
    const previous = this.#runs.get(scope.runId);
    if (!previous && this.#runs.size >= 1024) return;
    this.#runs.set(scope.runId, {
      scope,
      partition,
      update,
      revision: previous?.revision ?? 0,
      due: 0,
    });
  }
  forget(runId: string): void {
    this.#runs.delete(runId);
    this.#sending.get(runId)?.abort();
  }
  flush(): void {
    if (this.#closed) return;
    for (const [id, active] of [...this.#runs]) {
      if (this.#sending.size >= 4) break;
      if (this.#sending.has(id) || active.due > Date.now()) continue;
      active.due = Date.now() + RUN_PATH_PROBE_INTERVAL_MS;
      active.revision++;
      // Rotate admitted sends so continuously busy Runs cannot starve quiet ones.
      this.#runs.delete(id);
      this.#runs.set(id, active);
      const controller = new AbortController();
      this.#sending.set(id, controller);
      void this.#send(active, controller.signal).finally(() => this.#sending.delete(id));
    }
  }
  async #send(active: Active, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.send(
        new URL(RUN_ACTIVITY_PATH, this.#owners.get(active.partition) ?? this.baseUrl),
        {
          method: "POST",
          redirect: "manual",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            scope: active.scope,
            partition: active.partition,
            revision: active.revision,
            observedAt: Date.now(),
            ...active.update,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        },
      );
      const owner = response.headers.get("location");
      if (response.status === 307 && owner)
        this.#owners.set(active.partition, new URL(owner).origin);
      else if (!response.ok) this.#owners.delete(active.partition);
      await response.body?.cancel();
    } catch {
      this.#owners.delete(active.partition);
    }
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#runs.clear();
    for (const controller of this.#sending.values()) controller.abort();
  }
}
