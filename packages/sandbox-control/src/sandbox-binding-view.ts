import { BINDING_VIEW_PAGE_SIZE, type BindingViewPage } from "./sandbox-bindings.ts";
import type { SessionControlChange, SandboxBindingChange } from "@pi-cloud/protocol";
import type {
  SandboxBinding,
  SandboxBindingReader,
  SandboxBindingRecord,
} from "./sandbox-bindings.ts";

type Entry = {
  bytes: number;
  version: bigint;
  route?: SandboxBindingRecord;
  readers: number;
  closed: boolean;
};
const key = (tenant: string, id: string) => `${tenant}:${id}`;
const routeKey = (tenant: string, run: string, binding: string) => `${tenant}:${run}:${binding}`;

/** Current routing on the Session partition owner. PG is read at bootstrap or
 * a control change, never as an implicit fallback on Tool/probe lookup. */
export class SandboxBindingView implements SandboxBindingReader {
  readonly #entries = new Map<string, Entry>();
  readonly #writers = new Map<string, Set<string>>();
  #partitions = new Set<number>();
  #generation = 0;
  #ready = false;
  #bytes = 0;
  constructor(
    readonly options: {
      source: Pick<SandboxBindingReader, "closeWriter" | "isAlive"> & {
        loadView(page: BindingViewPage): Promise<readonly SandboxBindingRecord[]>;
        readChange(change: SandboxBindingChange): Promise<SandboxBindingRecord | undefined>;
      };
      partitionFor(session: string): number;
      partitionCount: number;
      maximumBytes?: number;
      maximumEntries?: number;
    },
  ) {}

  reset(): void {
    this.#generation++;
    this.#ready = false;
    this.#partitions.clear();
    this.#entries.clear();
    this.#bytes = 0;
    this.#writers.clear();
  }
  async load(partitions: readonly number[], current: () => boolean): Promise<void> {
    this.reset();
    const generation = this.#generation;
    this.#partitions = new Set(partitions);
    let after: BindingViewPage["after"];
    for (;;) {
      const rows = await this.options.source.loadView({
        partitions,
        partitionCount: this.options.partitionCount,
        ...(after ? { after } : {}),
      });
      if (!current() || generation !== this.#generation) return;
      for (const row of rows)
        if (this.#partitions.has(this.options.partitionFor(row.piSessionId)))
          this.#apply(
            this.#entry(routeKey(row.tenantId, row.runId, row.bindingId)),
            row,
            BigInt(row.revision),
          );
      if (rows.length < BINDING_VIEW_PAGE_SIZE) break;
      const last = rows.at(-1)!;
      after = { runId: last.runId, bindingId: last.bindingId };
    }
    this.#ready = true;
  }
  #entry(id: string): Entry {
    const old = this.#entries.get(id);
    if (old) return old;
    if (this.#entries.size >= (this.options.maximumEntries ?? 65_536)) {
      const disposable = [...this.#entries].find(([, e]) => !e.route && !e.readers);
      if (!disposable) throw new Error("Sandbox binding view capacity exceeded");
      this.#entries.delete(disposable[0]);
    }
    const entry: Entry = { bytes: 0, version: -1n, readers: 0, closed: false };
    this.#entries.set(id, entry);
    return entry;
  }
  #index(route: SandboxBindingRecord, add: boolean): void {
    for (const [index, identity] of [[this.#writers, route.writerId]] as const) {
      const id = key(route.tenantId, identity),
        binding = routeKey(route.tenantId, route.runId, route.bindingId);
      if (add) {
        let set = index.get(id);
        if (!set) index.set(id, (set = new Set()));
        set.add(binding);
      } else {
        const set = index.get(id);
        set?.delete(binding);
        if (!set?.size) index.delete(id);
      }
    }
  }
  #apply(entry: Entry, route: SandboxBindingRecord | undefined, version: bigint): void {
    // Binding identities never reopen. Positive PG absence is closure even
    // when the triggering Outbox retry predates the deleted row's last version.
    if (entry.closed && route && !route.dispatchClosed) return;
    if (route && version < entry.version) return;
    const routeBytes = route ? Buffer.byteLength(JSON.stringify(route)) : 0;
    const bytes = this.#bytes - entry.bytes + routeBytes;
    if (bytes > (this.options.maximumBytes ?? 64 * 1024 * 1024))
      throw new Error("Sandbox binding view byte capacity exceeded");
    this.#bytes = bytes;
    entry.bytes = routeBytes;
    if (entry.route) this.#index(entry.route, false);
    entry.version = version > entry.version ? version : entry.version;
    entry.closed ||= !route || route.dispatchClosed;
    if (route) entry.route = structuredClone(route);
    else delete entry.route;
    if (entry.route) this.#index(entry.route, true);
  }
  async #change(
    change: SandboxBindingChange,
    current: () => boolean,
    closureOnly: boolean,
  ): Promise<void> {
    if (
      !current() ||
      !this.#ready ||
      !this.#partitions.has(this.options.partitionFor(change.scope.piSessionId))
    )
      throw new Error("Sandbox binding view owner is unavailable");
    const generation = this.#generation;
    const entry = this.#entry(routeKey(change.scope.tenantId, change.runId, change.entityId));
    // Publication admission checks current PG closure even for an old retry:
    // an earlier unsent open notification must not hide a newer revocation.
    if (!closureOnly && BigInt(change.version) <= entry.version) return;
    entry.readers++;
    try {
      const row = await this.options.source.readChange(change);
      if (!current() || generation !== this.#generation) return;
      if (row && BigInt(row.revision) < BigInt(change.version))
        throw new Error("Sandbox binding state is behind its committed change");
      if (!closureOnly || !row || row.dispatchClosed)
        this.#apply(entry, row, row ? BigInt(row.revision) : BigInt(change.version));
    } finally {
      entry.readers--;
    }
  }
  prepare(change: SessionControlChange, current: () => boolean): Promise<void> {
    return change.entity === "sandbox_binding"
      ? this.#change(change, current, true)
      : Promise.resolve();
  }
  consume(change: SessionControlChange, current: () => boolean): Promise<void> {
    return change.entity === "sandbox_binding"
      ? this.#change(change, current, false)
      : Promise.resolve();
  }
  closure(change: SandboxBindingChange, current: () => boolean): SandboxBindingRecord | undefined {
    if (
      !change.closed ||
      !current() ||
      !this.#ready ||
      !this.#partitions.has(this.options.partitionFor(change.scope.piSessionId))
    )
      return;
    // prepare() may already have installed this revision. The closed fact still
    // needs its ordered effect, including during replay after a lost ACK.
    const row = this.#entries.get(
      routeKey(change.scope.tenantId, change.runId, change.entityId),
    )?.route;
    if (row && (!row.dispatchClosed || BigInt(row.revision) < BigInt(change.version)))
      throw new Error("Binding closure view is behind its fact");
    return row;
  }
  async find(
    scope: Parameters<SandboxBindingReader["find"]>[0],
  ): Promise<readonly SandboxBinding[]> {
    if (!this.#ready) throw new Error("Sandbox binding view has not recovered");
    if (!scope.tenantId) throw new Error("Sandbox binding scope has no tenant");
    const ids = this.#writers.get(key(scope.tenantId, scope.writerId));
    return [...(ids ?? [])].flatMap((id) => {
      const route = this.#entries.get(id)?.route;
      return route?.runId === scope.runId ? [route] : [];
    });
  }
  closeWriter(...args: Parameters<SandboxBindingReader["closeWriter"]>): Promise<void> {
    return this.options.source.closeWriter(...args);
  }
  isAlive(instanceId: string): Promise<boolean> {
    return this.options.source.isAlive(instanceId);
  }
}
