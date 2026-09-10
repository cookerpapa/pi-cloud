import type { ToolSandboxAssignment } from "@pi-cloud/protocol";
import { ToolBrokerError } from "./sandbox-provider.ts";

type Waiter = {
  activationId: string;
  assignment: ToolSandboxAssignment;
  signal?: AbortSignal;
  resolve(): void;
  reject(error: ToolBrokerError): void;
  abort?: () => void;
};

function cancelled() {
  return new ToolBrokerError(
    "tool_binding_admission_cancelled",
    "Tool binding admission was cancelled",
    false,
  );
}

/** One Broker's physical capacity, not Session scheduling or execution authority.
 * Warm-runtime eviction is supplied by the lifecycle owner; no PG or Cube API lives here. */
export class SandboxAdmission {
  readonly #assigned = new Map<string, ToolSandboxAssignment>();
  readonly #waiting: Waiter[] = [];
  #closed = false;

  constructor(
    readonly maximum: number,
    readonly evictWarm: () => Promise<boolean>,
  ) {}

  get size() {
    return this.#assigned.size;
  }
  get waitingCount() {
    return this.#waiting.length;
  }
  has(id: string) {
    return this.#assigned.has(id);
  }
  entries() {
    return this.#assigned.entries();
  }

  // Recovery accounts for already-running machines even if the configured
  // capacity was lowered. It must not pretend their physical resources are free.
  // An adoption already in flight may finish during close; recording it is not
  // permission to create another VM, and lets lifecycle teardown release it.
  restore(id: string, assignment: ToolSandboxAssignment) {
    this.#assigned.set(id, assignment);
  }
  transfer(from: string, to: string, assignment: ToolSandboxAssignment) {
    if (this.#assigned.delete(from)) this.#assigned.set(to, assignment);
  }

  #assertOpen(signal?: AbortSignal) {
    if (this.#closed)
      throw new ToolBrokerError(
        "tool_binding_admission_closed",
        "Tool binding admission closed",
        true,
      );
    if (signal?.aborted) throw cancelled();
  }

  async acquire(activationId: string, assignment: ToolSandboxAssignment, signal?: AbortSignal) {
    this.#assertOpen(signal);
    if (this.#assigned.has(activationId)) return;
    while (this.#assigned.size >= this.maximum) {
      if (!(await this.evictWarm())) break;
      this.#assertOpen(signal);
    }
    this.#assertOpen(signal);
    if (this.#assigned.size < this.maximum) {
      this.#assigned.set(activationId, assignment);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        activationId,
        assignment,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        waiter.abort = () => this.#remove(waiter, cancelled());
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#waiting.push(waiter);
    });
  }

  release(id: string) {
    if (!this.#assigned.delete(id) || this.#closed || this.#assigned.size >= this.maximum) return;
    const waiter = this.#waiting.shift();
    if (!waiter) return;
    this.#detach(waiter);
    this.#assigned.set(waiter.activationId, waiter.assignment);
    waiter.resolve();
  }
  cancel(id: string) {
    const waiter = this.#waiting.find((candidate) => candidate.activationId === id);
    if (waiter) this.#remove(waiter, cancelled());
  }
  #detach(waiter: Waiter) {
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
  }
  #remove(waiter: Waiter, error: ToolBrokerError) {
    const index = this.#waiting.indexOf(waiter);
    if (index < 0) return;
    this.#waiting.splice(index, 1);
    this.#detach(waiter);
    waiter.reject(error);
  }
  close() {
    this.#closed = true;
    for (const waiter of [...this.#waiting])
      this.#remove(
        waiter,
        new ToolBrokerError("tool_binding_admission_closed", "Tool binding admission closed", true),
      );
    this.#assigned.clear();
  }
}
