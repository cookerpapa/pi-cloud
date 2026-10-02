import { RUN_PATH_PROBE_INTERVAL_MS, RUN_OBSERVATION_STALE_MS } from "@pi-cloud/protocol";
import type { SandboxRuntimeObservation } from "./sandbox-provider.ts";

export type RuntimeHealthTarget = {
  id: string;
  observe(): Promise<SandboxRuntimeObservation>;
  probe(): Promise<unknown>;
  fail(): Promise<void>;
};
type Target = { target: RuntimeHealthTarget; due: number; successAt: number; pending: boolean };

/** Disposable physical-VM evidence. Cleanup and Session observations do not wait
 * for this bounded, due-time pump. Inventory never proves disappearance. */
export class RuntimeHealthMonitor {
  readonly #targets = new Map<string, Target>();
  readonly #active = new Set<Promise<void>>();
  readonly #timer: NodeJS.Timeout;
  #inventory = new Map<string, SandboxRuntimeObservation>();
  #inventoryAt = 0;
  #inventoryDue = 0;
  #inventoryPending: Promise<void> | undefined;
  #closed = false;
  readonly concurrency: number;
  constructor(
    readonly options: {
      targets(): readonly RuntimeHealthTarget[];
      inventory(): Promise<ReadonlyMap<string, SandboxRuntimeObservation>>;
      onError(error: unknown): void;
      sample?(stage: "probe" | "scheduling", durationMs: number, outcome: string): void;
      concurrency?: number;
      clock?: () => number;
    },
  ) {
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 64)
      throw new Error("Runtime probe concurrency must be between 1 and 64");
    this.#timer = setInterval(() => this.refresh(), 1000);
    this.#timer.unref();
  }
  #now(): number {
    return (this.options.clock ?? Date.now)();
  }
  refresh(): void {
    if (this.#closed) return;
    const current = new Set<string>();
    for (const target of this.options.targets()) {
      current.add(target.id);
      const entry = this.#targets.get(target.id);
      if (entry) entry.target = target;
      else this.#targets.set(target.id, { target, due: this.#now(), successAt: 0, pending: false });
    }
    for (const id of this.#targets.keys()) if (!current.has(id)) this.#targets.delete(id);
    if (!current.size) return;
    if (!this.#inventoryPending && this.#now() >= this.#inventoryDue) {
      this.#inventoryDue = this.#now() + 30_000;
      this.#inventoryPending = this.options
        .inventory()
        .then((value) => {
          this.#inventory = new Map(value);
          this.#inventoryAt = this.#now();
        })
        .catch((error) => {
          this.#inventory.clear();
          this.options.onError(error);
        })
        .finally(() => {
          this.#inventoryPending = undefined;
          this.#pump();
        });
    }
    // Let a first inventory finish before issuing per-VM exact observations.
    if (this.#inventoryAt || !this.#inventoryPending) this.#pump();
  }
  evidence(id: string, observedAt: number): boolean {
    const now = this.#now(),
      target = this.#targets.get(id);
    if (
      !target ||
      !Number.isFinite(observedAt) ||
      observedAt > now + 5000 ||
      observedAt < now - RUN_OBSERVATION_STALE_MS ||
      observedAt <= target.successAt
    )
      return false;
    target.successAt = observedAt;
    target.due = Math.max(target.due, Math.min(now, observedAt) + RUN_PATH_PROBE_INTERVAL_MS);
    return true;
  }
  #pump(): void {
    if (this.#closed) return;
    const now = this.#now();
    const due = [...this.#targets.values()]
      .filter((t) => !t.pending && t.due <= now)
      .sort((a, b) => a.due - b.due);
    for (const entry of due) {
      if (this.#active.size >= this.concurrency) break;
      entry.pending = true;
      this.options.sample?.("scheduling", now - entry.due, "due");
      entry.due = now + RUN_PATH_PROBE_INTERVAL_MS;
      const task = this.#check(entry)
        .catch((error) => this.options.onError(error))
        .finally(() => {
          this.#active.delete(task);
          entry.pending = false;
          entry.due = Math.max(entry.due, this.#now() + RUN_PATH_PROBE_INTERVAL_MS);
          this.#pump();
        });
      this.#active.add(task);
    }
  }
  #current(entry: Target): boolean {
    return !this.#closed && this.#targets.get(entry.target.id) === entry;
  }
  async #classify(entry: Target, observation: SandboxRuntimeObservation): Promise<boolean> {
    if (!this.#current(entry)) return false;
    if (
      observation.presence === "absent" ||
      observation.execution === "unsafe" ||
      (observation.presence === "present" && ["stopped", "error"].includes(observation.state))
    ) {
      await entry.target.fail();
      return false;
    }
    return observation.presence === "present" && observation.state === "running";
  }
  async #check(entry: Target): Promise<void> {
    const inventory =
      this.#now() - this.#inventoryAt < 30_000 ? this.#inventory.get(entry.target.id) : undefined;
    const observed = inventory ?? (await entry.target.observe());
    if (!(await this.#classify(entry, observed))) return;
    if (entry.successAt > 0 && this.#now() - entry.successAt < RUN_PATH_PROBE_INTERVAL_MS) return;
    const started = this.#now();
    try {
      await entry.target.probe();
      if (this.#current(entry)) this.evidence(entry.target.id, this.#now());
      this.options.sample?.("probe", this.#now() - started, "success");
    } catch (error) {
      this.options.sample?.("probe", this.#now() - started, "unconfirmed");
      // Timeout is diagnostic, not deletion authority. Only independent exact
      // management evidence can quarantine the physical target.
      if (this.#current(entry)) await this.#classify(entry, await entry.target.observe());
      this.options.onError(error);
    }
  }
  async settle(): Promise<void> {
    await this.#inventoryPending;
    while (this.#active.size) await Promise.allSettled([...this.#active]);
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.settle();
    this.#targets.clear();
  }
}
