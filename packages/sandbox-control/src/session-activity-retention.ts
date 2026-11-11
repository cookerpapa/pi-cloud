import {
  SESSION_ACTIVITY_FRESH_MS,
  type SessionActivity,
  type SessionResourceUse,
} from "@pi-cloud/protocol";
import type { RuntimeRetention, RuntimeRetentionTarget } from "./runtime-retention.ts";
import type { SandboxBindingRecord } from "./sandbox-bindings.ts";

type Entry = {
  revision: number;
  target?: RuntimeRetentionTarget;
  loaded: boolean;
  loading?: Promise<void>;
};
/** Disposable resource view. Its cold reader addresses resource metadata only;
 * maintenance never discovers Workers or checks their execution leases. */
export class SessionActivityRetention {
  readonly #resources = new Map<string, Entry>();
  readonly #work = new Set<Promise<void>>();
  #generation = 0;
  #closed = false;
  constructor(
    readonly options: {
      retention: RuntimeRetention;
      read(tenantId: string, use: SessionResourceUse): Promise<RuntimeRetentionTarget | undefined>;
      clock?: () => number;
    },
  ) {}
  #key(tenant: string, use: SessionResourceUse) {
    return JSON.stringify([tenant, use.workspaceId, use.computeSessionId ?? null]);
  }
  #entry(key: string) {
    let entry = this.#resources.get(key);
    if (!entry) {
      if (this.#resources.size >= 4096)
        this.#resources.delete(this.#resources.keys().next().value!);
      entry = { revision: 0, loaded: false };
      this.#resources.set(key, entry);
    }
    return entry;
  }
  remember(binding: SandboxBindingRecord): void {
    if (this.#closed || binding.dispatchClosed) return;
    if (binding.snapshot.developmentEnvironmentId && !binding.snapshot.computeSessionId) return;
    const use = {
      workspaceId: binding.snapshot.assignment.workspaceId,
      ...(binding.snapshot.computeSessionId
        ? { computeSessionId: binding.snapshot.computeSessionId }
        : {}),
    };
    const entry = this.#entry(this.#key(binding.tenantId, use));
    entry.revision++;
    entry.loaded = true;
    entry.target = {
      id: binding.snapshot.physicalActivationId,
      tenantId: binding.tenantId,
      kind: "workspace",
    };
  }
  consume(fact: SessionActivity, current: () => boolean): void {
    const at = Date.parse(fact.occurredAt),
      generation = this.#generation;
    const valid = () => {
      const now = this.options.clock?.() ?? Date.now();
      return (
        !this.#closed &&
        this.#generation === generation &&
        current() &&
        at <= now + 5000 &&
        now - at <= SESSION_ACTIVITY_FRESH_MS
      );
    };
    if (!valid()) return;
    for (const use of fact.resources) {
      const key = this.#key(fact.scope.tenantId, use),
        entry = this.#entry(key);
      if (!entry.loaded && !entry.loading) {
        if (this.#work.size >= 4) continue; // Later declarations retry; never block the partition.
        const revision = entry.revision;
        const work = this.options
          .read(fact.scope.tenantId, use)
          .then((target) => {
            if (valid() && this.#resources.get(key) === entry && entry.revision === revision) {
              if (target) entry.target = target;
              else delete entry.target;
              entry.loaded = true;
            }
          })
          .catch(() => {})
          .finally(() => {
            delete entry.loading;
            this.#work.delete(work);
          });
        entry.loading = work;
        this.#work.add(work);
      }
      const retain = () => {
        if (valid() && entry.target)
          this.options.retention.retain(entry.target, {
            writerId: fact.scope.writerId,
            observedAt: at,
            current: valid,
          });
      };
      if (entry.loading) void entry.loading.then(retain);
      else retain();
    }
  }
  reset(): void {
    this.#generation++;
    this.#resources.clear();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.reset();
    await Promise.allSettled(this.#work);
  }
}
