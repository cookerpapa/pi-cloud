import type { Database } from "@pi-cloud/database";
import {
  type RunCancellationExecutionResult,
  RunCancellationExecutor,
} from "@pi-cloud/runtime-core/run-cancellation-executor";
import { type RunExecutionResult, RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import type { Kysely } from "kysely";
import { Client } from "pg";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const LOCAL_SUBAGENT_PRIORITY_DELAY_MS = 25;

type ExecutionReference = {
  runId: string;
  subagent: boolean;
};

export function selectPiWorkerSlotKinds(
  active: readonly ExecutionReference[],
  maximumConcurrentRuns: number,
): boolean[] {
  positiveInteger(maximumConcurrentRuns, "maximumConcurrentRuns");
  const activeParents = active.filter((entry) => !entry.subagent).length;
  const maximumParents = maximumConcurrentRuns < 2 ? 1 : maximumConcurrentRuns - 1;
  const available = Math.max(0, maximumConcurrentRuns - active.length);
  const parentSlots = Math.min(available, Math.max(0, maximumParents - activeParents));
  return [
    ...Array.from({ length: parentSlots }, () => false),
    ...Array.from({ length: available - parentSlots }, () => true),
  ];
}

export function canPrioritizeLocalSubagent(
  runId: string,
  active: readonly ExecutionReference[],
  maximumConcurrentRuns: number,
): boolean {
  positiveInteger(maximumConcurrentRuns, "maximumConcurrentRuns");
  return !active.some((entry) => entry.runId === runId) && active.length < maximumConcurrentRuns;
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
  maximumConcurrentRuns: number;
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
  readonly #maximumConcurrentRuns: number;
  readonly #pollIntervalMs: number;
  readonly #runExecutor: RunExecutor;
  readonly #cancellationExecutor: RunCancellationExecutor;
  readonly #canClaimRuns: () => boolean;
  readonly #admitRunClaims: () => Promise<boolean>;
  readonly #onFailure:
    ((operation: "listen" | "claim" | "execute" | "cancel", error: unknown) => void) | undefined;
  readonly #activeRuns = new Map<
    string,
    Readonly<{ execution: Promise<void>; subagent: boolean }>
  >();
  #state: PostgresPiWorkerState = "idle";
  #controller: AbortController | undefined;
  #listener: Client | undefined;
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
    this.#maximumConcurrentRuns = positiveInteger(
      options.maximumConcurrentRuns,
      "maximumConcurrentRuns",
    );
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
      await this.#startListener();
      this.#state = "running";
      this.#loop = this.#run(this.#controller.signal).finally(() => {
        if (this.#state !== "stopping") this.#state = "stopped";
      });
    } catch (error: unknown) {
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
    this.#controller?.abort();
    this.#queueWake.notify();
    await this.#loop;
    await Promise.allSettled([...this.#activeRuns.values()].map((entry) => entry.execution));
    await this.#listener?.end().catch(() => undefined);
    this.#state = "stopped";
  }

  prioritizeSubagent(runId: string): boolean {
    bounded(runId, "Subagent runId", 256);
    if (this.#state !== "running" || !this.#canClaimRuns()) return false;
    const active = [...this.#activeRuns.entries()].map(([activeRunId, entry]) => ({
      runId: activeRunId,
      subagent: entry.subagent,
    }));
    if (!canPrioritizeLocalSubagent(runId, active, this.#maximumConcurrentRuns)) return false;
    const execution = (async () => {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, LOCAL_SUBAGENT_PRIORITY_DELAY_MS);
        timer.unref();
      });
      if (this.#state !== "running" || !this.#canClaimRuns()) return;
      if (!(await this.#admitRunClaims())) return;
      await this.#executeRun(runId);
    })().finally(() => {
      this.#activeRuns.delete(runId);
      this.#queueWake.notify();
    });
    this.#activeRuns.set(runId, { execution, subagent: true });
    return true;
  }

  async #startListener(): Promise<void> {
    const listener = new Client({
      connectionString: this.#notificationConnectionString,
      application_name: `${this.#identity}-run-queue`,
    });
    listener.on("notification", (message) => {
      if (message.channel === "pi_cloud_run_queue") this.#queueWake.notify();
    });
    listener.on("error", (error) => this.#observeFailure("listen", error));
    await listener.connect();
    await listener.query("listen pi_cloud_run_queue");
    this.#listener = listener;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const observedGeneration = this.#queueWake.generation;
      try {
        await this.#dispatchCancellations();
        await this.#fillCapacity();
      } catch (error: unknown) {
        this.#observeFailure("claim", error);
      }
      await this.#queueWake.wait(observedGeneration, this.#pollIntervalMs, signal);
    }
  }

  async #fillCapacity(): Promise<void> {
    if (!this.#canClaimRuns()) return;
    const slots = selectPiWorkerSlotKinds(
      [...this.#activeRuns.entries()].map(([runId, entry]) => ({
        runId,
        subagent: entry.subagent,
      })),
      this.#maximumConcurrentRuns,
    );
    if (slots.length === 0 || !(await this.#admitRunClaims())) return;
    for (const subagent of slots) {
      const slotId = `slot:${globalThis.crypto.randomUUID()}`;
      let claimed = false;
      const execution = this.#executeNext(subagent)
        .then((value) => {
          claimed = value;
        })
        .finally(() => {
          this.#activeRuns.delete(slotId);
          if (claimed) this.#queueWake.notify();
        });
      this.#activeRuns.set(slotId, { execution, subagent });
    }
  }

  async #dispatchCancellations(): Promise<void> {
    if (this.#activeRuns.size === 0) return;
    const references = await this.#cancellationReferences();
    await Promise.all(
      references.map(async (reference) => {
        try {
          await this.#cancellationExecutor.dispatchTargetRun(reference.targetRunId);
        } catch (error: unknown) {
          this.#observeFailure("cancel", error);
        }
      }),
    );
  }

  async #executeRun(runId: string): Promise<void> {
    try {
      const result = await this.#runExecutor.dispatchRun(runId);
      await this.#settleDispatchResult(result);
    } catch (error: unknown) {
      this.#observeFailure("execute", error);
    }
  }

  async #executeNext(subagent: boolean): Promise<boolean> {
    try {
      const result = await this.#runExecutor.dispatchNext(subagent ? "subagent" : "conversation");
      await this.#settleDispatchResult(result);
      return result.status !== "idle";
    } catch (error: unknown) {
      this.#observeFailure("execute", error);
      return false;
    }
  }

  async #settleDispatchResult(_result: RunExecutionResult): Promise<void> {
    // RunExecutor owns every durable transition. The queue only needs
    // another claim: completed work is published, while a deferred/retryable
    // record carries its next available_at timestamp.
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
      .limit(this.#maximumConcurrentRuns)
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
