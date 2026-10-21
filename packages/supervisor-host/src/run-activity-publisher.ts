import {
  RUN_ACTIVITY_PATH,
  RUN_PATH_PROBE_INTERVAL_MS,
  type RunActivityUpdate,
  type RunActivityParent,
  type RuntimeObservationScope,
  EXECUTION_OBSERVATION_PATH,
  EXECUTION_READINESS_PATH,
  RUN_OBSERVATION_STALE_MS,
  type ExecutionObservationDelivery,
} from "@pi-cloud/protocol";

const observationKey = (scope: RuntimeObservationScope) => `${scope.runId}:${scope.sessionId}`;

type Active = {
  scope: RuntimeObservationScope;
  partition: number;
  update: RunActivityUpdate;
  parent?: RunActivityParent;
  revision: number;
  due: number;
};

/** One latest snapshot per active Run, at most four bounded HTTP sends in flight. */
export class RunActivityPublisher {
  readonly #runs = new Map<string, Active>();
  readonly #sending = new Map<string, AbortController>();
  readonly #owners = new Map<number, string>();
  readonly #executions = new Map<string, ExecutionObservationDelivery>();
  readonly #confirmations = new Set<AbortController>();
  #executionFirst = false;
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
  update(
    scope: RuntimeObservationScope,
    partition: number,
    update: RunActivityUpdate,
    parent?: RunActivityParent,
  ): void {
    if (this.#closed) return;
    const previous = this.#runs.get(observationKey(scope));
    if (!previous && this.#runs.size >= 1024) return;
    this.#runs.set(observationKey(scope), {
      scope,
      partition,
      update,
      ...(parent ? { parent } : {}),
      revision: previous?.revision ?? 0,
      due: 0,
    });
  }
  forget(runId: string, sessionId?: string): void {
    const keys = new Set([
      ...[...this.#runs]
        .filter(
          ([, v]) => v.scope.runId === runId && (!sessionId || v.scope.sessionId === sessionId),
        )
        .map(([key]) => key),
      ...[...this.#executions]
        .filter(
          ([, v]) => v.scope.runId === runId && (!sessionId || v.scope.sessionId === sessionId),
        )
        .map(([key]) => key),
    ]);
    for (const key of keys) {
      this.#runs.delete(key);
      this.#executions.delete(key);
      this.#sending.get(`execution:${key}`)?.abort();
      this.#sending.get(key)?.abort();
    }
  }
  flush(): void {
    if (this.#closed) return;
    this.#executionFirst = !this.#executionFirst;
    if (this.#executionFirst) this.#flushExecutions(2);
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
    this.#flushExecutions(4);
  }
  execution(delivery: ExecutionObservationDelivery): void {
    if (
      this.#closed ||
      (this.#executions.size >= 1024 && !this.#executions.has(observationKey(delivery.scope)))
    )
      return;
    const previous = this.#executions.get(observationKey(delivery.scope));
    if (!previous || previous.evidence.observedAt <= delivery.evidence.observedAt)
      this.#executions.set(observationKey(delivery.scope), delivery);
  }
  /** Fault-path read only; the caller's deadline covers probing and this confirmation. */
  async confirmExecution(
    delivery: ExecutionObservationDelivery,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#closed || signal.aborted || this.#confirmations.size >= 4) return false;
    const controller = new AbortController();
    this.#confirmations.add(controller);
    const active = AbortSignal.any([signal, controller.signal]);
    try {
      // One retry accommodates the existing partition-owner redirect, never Tool replay.
      for (let attempt = 0; attempt < 2 && !active.aborted; attempt++)
        if (await this.#post(EXECUTION_READINESS_PATH, delivery.partition, delivery, active))
          return !active.aborted && !this.#closed;
      return false;
    } finally {
      this.#confirmations.delete(controller);
    }
  }
  #flushExecutions(maximum: number): void {
    let sent = 0;
    for (const [runId, delivery] of this.#executions) {
      if (Date.now() - delivery.evidence.observedAt > RUN_OBSERVATION_STALE_MS) {
        this.#executions.delete(runId);
        continue;
      }
      if (this.#sending.size >= 4 || sent >= maximum) break;
      const key = `execution:${runId}`;
      if (this.#sending.has(key)) continue;
      this.#executions.delete(runId);
      this.#executions.set(runId, delivery);
      const controller = new AbortController();
      this.#sending.set(key, controller);
      sent++;
      void this.#post(EXECUTION_OBSERVATION_PATH, delivery.partition, delivery, controller.signal)
        .then((sent) => {
          if (sent && this.#executions.get(runId) === delivery) this.#executions.delete(runId);
        })
        .finally(() => this.#sending.delete(key));
    }
  }
  async #post(
    path: string,
    partition: number,
    value: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await this.send(new URL(path, this.#owners.get(partition) ?? this.baseUrl), {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(value),
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      const owner = response.headers.get("location");
      if (response.status === 307 && owner) this.#owners.set(partition, new URL(owner).origin);
      else if (!response.ok) this.#owners.delete(partition);
      await response.body?.cancel();
      return path === EXECUTION_READINESS_PATH ? response.status === 204 : response.ok;
    } catch {
      this.#owners.delete(partition);
      return false;
    }
  }
  async #send(active: Active, signal: AbortSignal): Promise<void> {
    await this.#post(
      RUN_ACTIVITY_PATH,
      active.partition,
      {
        scope: active.scope,
        ...(active.parent ? { parent: active.parent } : {}),
        partition: active.partition,
        revision: active.revision,
        observedAt: Date.now(),
        ...active.update,
      },
      signal,
    );
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#runs.clear();
    this.#executions.clear();
    for (const controller of this.#sending.values()) controller.abort();
    for (const controller of this.#confirmations) controller.abort();
  }
}
