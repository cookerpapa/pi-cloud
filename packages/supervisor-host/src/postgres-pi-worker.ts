import type { Database } from "@pi-cloud/database";
import {
  type RunCancellationExecutionResult,
  RunCancellationExecutor,
} from "@pi-cloud/runtime-core/run-cancellation-executor";
import {
  RunExecutor,
  type RunClaimAdmission,
  type RunClaimReference,
} from "@pi-cloud/runtime-core/run-executor";
import { getHeapStatistics } from "node:v8";
import type { Kysely } from "kysely";
import { Client } from "pg";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type ExecutionReference = { runId: string; tenantId: string; piSessionId: string };
export const familyKey = (r: Pick<ExecutionReference, "tenantId" | "piSessionId">): string =>
  `${r.tenantId}:${r.piSessionId}`;

export function familyAdmission(
  active: readonly ExecutionReference[],
  capacity: number,
  maximumLanesPerFamily: number,
  memoryHeadroom = true,
): RunClaimAdmission {
  const counts = new Map<string, number>();
  for (const r of active) counts.set(familyKey(r), (counts.get(familyKey(r)) ?? 0) + 1);
  return {
    ...(counts.size < capacity && memoryHeadroom ? {} : { allowedFamilyKeys: [...counts.keys()] }),
    blockedFamilyKeys: [...counts]
      .filter(([, count]) => count >= maximumLanesPerFamily)
      .map(([key]) => key),
  };
}

export function workerMemoryHeadroom(): boolean {
  const heap = getHeapStatistics();
  const memory = process.memoryUsage();
  const constrained = process.constrainedMemory();
  return (
    memory.heapUsed < heap.heap_size_limit * 0.85 &&
    (constrained === 0 || memory.rss < constrained * 0.85)
  );
}

type CancellationReference = {
  targetRunId: string;
};

export class PostgresQueueWake {
  #generation = 0;
  #wake: (() => void) | undefined;

  get generation(): number {
    return this.#generation;
  }

  notify(): void {
    this.#generation += 1;
    this.#wake?.();
  }

  wait(observedGeneration: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#generation !== observedGeneration) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(settle, timeoutMs);
      timer.unref();
      const onAbort = (): void => settle();
      this.#wake = settle;
      if (this.#generation !== observedGeneration) settle();
      function settle(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => {
      this.#wake = undefined;
    });
  }
}

export type PostgresPiWorkerOptions = {
  database: Kysely<Database>;
  notificationConnectionString: string;
  identity: string;
  maximumActiveFamilies: number;
  maximumLanesPerFamily: number;
  memoryHeadroom?: () => boolean;
  onCapacity?: (sample: { families: number; lanes: number }) => void;
  pollIntervalMs?: number;
  runExecutor: RunExecutor;
  cancellationExecutor: RunCancellationExecutor;
  /**
   * A Worker may claim new Runs only while its control-channel ownership is
   * current. Existing Runs and cancellation delivery are intentionally not
   * gated here: they settle through their existing Lease/Fence authority.
   */
  canClaimRuns?: () => boolean;
  /** Checks external execution-plane readiness only when claimable work exists. */
  admitRunClaims?: () => Promise<boolean>;
  onFailure?: (operation: "listen" | "claim" | "execute" | "cancel", error: unknown) => void;
};

export type PostgresPiWorkerState = "idle" | "starting" | "running" | "stopping" | "stopped";

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function bounded(value: string, name: string, maximum: number): string {
  if (value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * A bounded, horizontally scalable PostgreSQL-backed Pi Worker.
 *
 * PostgreSQL owns the queue and the exact Run/Attempt lifecycle. LISTEN/NOTIFY
 * only removes idle polling latency; every wake-up is followed by a fresh
 * authoritative query. RunExecutor remains the transactional claimant,
 * so duplicate notifications and competing Workers are harmless.
 */
export class PostgresPiWorker {
  readonly #database: Kysely<Database>;
  readonly #notificationConnectionString: string;
  readonly #identity: string;
  readonly #maximumActiveFamilies: number;
  readonly #maximumLanesPerFamily: number;
  readonly #memoryHeadroom: () => boolean;
  readonly #onCapacity: NonNullable<PostgresPiWorkerOptions["onCapacity"]>;
  readonly #pollIntervalMs: number;
  readonly #runExecutor: RunExecutor;
  readonly #cancellationExecutor: RunCancellationExecutor;
  readonly #canClaimRuns: () => boolean;
  readonly #admitRunClaims: () => Promise<boolean>;
  readonly #onFailure:
    ((operation: "listen" | "claim" | "execute" | "cancel", error: unknown) => void) | undefined;
  readonly #activeRuns = new Map<
    string,
    Readonly<{ execution: Promise<void>; reference?: RunClaimReference }>
  >();
  readonly #activeCancellations = new Map<string, Promise<void>>();
  #claiming = false;
  #state: PostgresPiWorkerState = "idle";
  #controller: AbortController | undefined;
  #listener: Client | undefined;
  #listenerOpening: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  readonly #queueWake = new PostgresQueueWake();

  constructor(options: PostgresPiWorkerOptions) {
    this.#database = options.database;
    this.#notificationConnectionString = bounded(
      options.notificationConnectionString,
      "notificationConnectionString",
      8_192,
    );
    this.#identity = bounded(options.identity, "identity", 256);
    this.#maximumActiveFamilies = positiveInteger(
      options.maximumActiveFamilies,
      "maximumActiveFamilies",
    );
    this.#maximumLanesPerFamily = positiveInteger(
      options.maximumLanesPerFamily,
      "maximumLanesPerFamily",
    );
    this.#memoryHeadroom = options.memoryHeadroom ?? workerMemoryHeadroom;
    this.#onCapacity = options.onCapacity ?? (() => {});
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#runExecutor = options.runExecutor;
    this.#cancellationExecutor = options.cancellationExecutor;
    this.#canClaimRuns = options.canClaimRuns ?? (() => true);
    this.#admitRunClaims = options.admitRunClaims ?? (() => Promise.resolve(true));
    this.#onFailure = options.onFailure;
  }

  get state(): PostgresPiWorkerState {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("PostgreSQL Pi Worker can only start once");
    this.#state = "starting";
    this.#controller = new AbortController();
    try {
      this.#listenerOpening = this.#startListener();
      await this.#listenerOpening;
      this.#listenerOpening = undefined;
      if (this.#controller.signal.aborted) throw new Error("Worker stopped during startup");
      this.#state = "running";
      this.#loop = this.#run(this.#controller.signal).finally(() => {
        if (this.#state !== "stopping") this.#state = "stopped";
      });
    } catch (error: unknown) {
      this.#listenerOpening = undefined;
      this.#state = "stopped";
      await this.#listener?.end().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    this.#queueWake.notify();
    await this.#loop;
    this.#controller?.abort();
    await this.#listenerOpening?.catch(() => undefined);
    await Promise.allSettled([...this.#activeRuns.values()].map((entry) => entry.execution));
    await this.#listener?.end().catch(() => undefined);
    this.#state = "stopped";
  }

  scheduleOwnedSubagent(runId: string): boolean {
    bounded(runId, "Subagent runId", 256);
    if (!["running", "stopping"].includes(this.#state) || !this.#canClaimRuns()) return false;
    // A hint, not a second bypass around admission. All Lanes use the same probe.
    this.#queueWake.notify();
    return true;
  }

  async #startListener(): Promise<void> {
    let disconnected = false;
    const listener = new Client({
      connectionString: this.#notificationConnectionString,
      application_name: `${this.#identity}-run-queue`,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
      keepAlive: true,
    });
    listener.on("notification", (message) => {
      if (message.channel === "pi_cloud_run_queue") this.#queueWake.notify();
    });
    listener.on("error", (error) => {
      disconnected = true;
      this.#observeFailure("listen", error);
      if (this.#listener === listener) this.#listener = undefined;
      void listener.end().catch(() => undefined);
      this.#queueWake.notify();
    });
    listener.once("end", () => {
      disconnected = true;
      if (this.#listener === listener) {
        this.#listener = undefined;
        this.#queueWake.notify();
      }
    });
    try {
      await listener.connect();
      await listener.query("listen pi_cloud_run_queue");
      if (disconnected) throw new Error("Queue notification connection closed during setup");
      if (this.#controller?.signal.aborted) await listener.end();
      else this.#listener = listener;
    } catch (error) {
      await listener.end().catch(() => undefined);
      throw error;
    }
  }

  #refreshListener(): void {
    if (this.#listener || this.#listenerOpening || this.#controller?.signal.aborted) return;
    // Polling still owns correctness while the session-bound LISTEN reconnects.
    // Use the existing loop as the retry cadence, with only one connection attempt.
    this.#listenerOpening = this.#startListener()
      .catch((error) => this.#observeFailure("listen", error))
      .finally(() => {
        this.#listenerOpening = undefined;
      });
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (
      !signal.aborted &&
      (this.#state !== "stopping" ||
        this.#activeRuns.size > 0 ||
        this.#activeCancellations.size > 0 ||
        this.#claiming)
    ) {
      const observedGeneration = this.#queueWake.generation;
      this.#refreshListener();
      try {
        await this.#dispatchCancellations();
        await this.#fillCapacity();
      } catch (error: unknown) {
        this.#observeFailure("claim", error);
      }
      await this.#queueWake.wait(observedGeneration, this.#pollIntervalMs, signal);
    }
  }

  #activeReferences(): RunClaimReference[] {
    return [...this.#activeRuns.values()].flatMap((entry) =>
      entry.reference ? [entry.reference] : [],
    );
  }
  #observeCapacity(): void {
    const active = this.#activeReferences();
    this.#onCapacity({ families: new Set(active.map(familyKey)).size, lanes: active.length });
  }
  async #fillCapacity(): Promise<void> {
    if (this.#claiming || !this.#canClaimRuns()) return;
    if (!(await this.#admitRunClaims()) || !this.#canClaimRuns()) return;
    const admission = familyAdmission(
      this.#activeReferences(),
      this.#maximumActiveFamilies,
      this.#maximumLanesPerFamily,
      this.#state === "running" && this.#memoryHeadroom(),
    );
    if (admission.allowedFamilyKeys?.length === 0) return;
    this.#claiming = true;
    const slotId = globalThis.crypto.randomUUID();
    let claimed = false;
    const execution = this.#runExecutor
      .dispatchNext(admission, (reference) => {
        claimed = true;
        const active = this.#activeRuns.get(slotId);
        if (active) this.#activeRuns.set(slotId, { ...active, reference });
        this.#claiming = false;
        this.#observeCapacity();
        this.#queueWake.notify();
      })
      .then(() => {})
      .catch((error) => this.#observeFailure("execute", error))
      .finally(() => {
        if (!claimed) this.#claiming = false;
        this.#activeRuns.delete(slotId);
        this.#observeCapacity();
        if (claimed) this.#queueWake.notify();
      });
    this.#activeRuns.set(slotId, { execution });
  }

  async #dispatchCancellations(): Promise<void> {
    if (this.#activeRuns.size === 0) return;
    const references = await this.#cancellationReferences();
    for (const { targetRunId } of references) {
      if (this.#activeCancellations.has(targetRunId)) continue;
      // Cancellation can wait for guest/Agent cleanup. It must not hold the
      // shared claim loop, but shutdown must still join its durable settlement.
      const task = Promise.resolve()
        .then(() => this.#cancellationExecutor.dispatchTargetRun(targetRunId))
        .then(
          () => {},
          (error) => this.#observeFailure("cancel", error),
        )
        .finally(() => {
          this.#activeCancellations.delete(targetRunId);
          // Normal retry timing belongs to PG and the poll loop, not a
          // self-waking rejection loop. Only drain needs an immediate wake.
          if (this.#state === "stopping") this.#queueWake.notify();
        });
      this.#activeCancellations.set(targetRunId, task);
    }
  }

  async #cancellationReferences(): Promise<CancellationReference[]> {
    return this.#database
      .selectFrom("turn_control_requests as cancellation")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "cancellation.tenant_id")
          .onRef("run.id", "=", "cancellation.target_run_id"),
      )
      .innerJoin("run_attempts as attempt", (join) =>
        join
          .onRef("attempt.run_id", "=", "run.id")
          .onRef("attempt.id", "=", "run.current_attempt_id"),
      )
      .select("run.id as targetRunId")
      .where("cancellation.available_at", "<=", new Date())
      .where("cancellation.kind", "=", "cancel")
      .where("cancellation.state", "in", ["pending", "dispatched"])
      .where("attempt.claim_owner_id", "=", this.#identity)
      .where("attempt.state", "in", ["provisioning", "restoring", "running", "settling"])
      .limit(this.#maximumActiveFamilies * this.#maximumLanesPerFamily)
      .execute();
  }

  #observeFailure(operation: "listen" | "claim" | "execute" | "cancel", error: unknown): void {
    try {
      this.#onFailure?.(operation, error);
    } catch {
      // Observability cannot become queue authority.
    }
  }
}

export type { RunCancellationExecutionResult };
