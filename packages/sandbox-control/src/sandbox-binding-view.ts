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
const routeKey = (tenant: string, run: string, binding: string) => `${tenant}:${run}:${binding}`;

/** Current routing on the Session partition owner. PG is read at bootstrap or
 * a control change, never as an implicit fallback on Tool/probe lookup. */
export class SandboxBindingView implements SandboxBindingReader {
  readonly #entries = new Map<string, Entry>();
  readonly #bindings = new Map<string, Entry>();
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
    this.#bindings.clear();
    this.#bytes = 0;
  }
  owner(sessionId: string): (() => boolean) | undefined {
    const generation = this.#generation;
    const partition = this.options.partitionFor(sessionId);
    if (!this.#ready || !this.#partitions.has(partition)) return;
    return () => this.#ready && generation === this.#generation && this.#partitions.has(partition);
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
    entry.version = version > entry.version ? version : entry.version;
    entry.closed ||= !route || route.dispatchClosed;
    if (route) {
      entry.route = structuredClone(route);
      this.#bindings.set(route.bindingId, entry);
    } else {
      if (entry.route) this.#bindings.delete(entry.route.bindingId);
      delete entry.route;
    }
  }
  async #change(change: SandboxBindingChange, current: () => boolean): Promise<void> {
    if (
      !current() ||
      !this.#ready ||
      !this.#partitions.has(this.options.partitionFor(change.scope.piSessionId))
    )
      throw new Error("Sandbox binding view owner is unavailable");
    const generation = this.#generation;
    const entry = this.#entry(routeKey(change.scope.tenantId, change.runId, change.entityId));
    if (BigInt(change.version) <= entry.version) return;
    entry.readers++;
    try {
      const row = await this.options.source.readChange(change);
      if (!current() || generation !== this.#generation) return;
      if (row && BigInt(row.revision) < BigInt(change.version))
        throw new Error("Sandbox binding state is behind its committed change");
      this.#apply(entry, row, row ? BigInt(row.revision) : BigInt(change.version));
    } finally {
      entry.readers--;
    }
  }
  consume(change: SessionControlChange, current: () => boolean): Promise<void> {
    return change.entity === "sandbox_binding" ? this.#change(change, current) : Promise.resolve();
  }
  closure(change: SandboxBindingChange, current: () => boolean): SandboxBindingRecord | undefined {
    if (
      !change.closed ||
      !current() ||
      !this.#ready ||
      !this.#partitions.has(this.options.partitionFor(change.scope.piSessionId))
    )
      return;
    // Bootstrap may already have installed this revision. The ordered fact still
    // needs its side effects and acknowledgement after a lost publication reply.
    const row = this.#entries.get(
      routeKey(change.scope.tenantId, change.runId, change.entityId),
    )?.route;
    if (row && (!row.dispatchClosed || BigInt(row.revision) < BigInt(change.version)))
      throw new Error("Binding closure view is behind its fact");
    return row;
  }
  async get(
    scope: Parameters<SandboxBindingReader["get"]>[0],
    bindingId: string,
  ): Promise<SandboxBinding | undefined> {
    if (!this.#ready) throw new Error("Sandbox binding view has not recovered");
    if (!scope.tenantId) throw new Error("Sandbox binding scope has no tenant");
    const route = this.#entries.get(routeKey(scope.tenantId, scope.runId, bindingId))?.route;
    return route?.writerId === scope.writerId ? route : undefined;
  }
  /** Execution-side HTTP attachments share the same prepared partition view. */
  binding(bindingId: string): SandboxBindingRecord | undefined {
    if (!this.#ready) throw new Error("Sandbox binding view has not recovered");
    return this.#bindings.get(bindingId)?.route;
  }
  writerBindings(writerId: string): SandboxBindingRecord[] {
    if (!this.#ready) return [];
    return [...this.#bindings.values()].flatMap((entry) =>
      entry.route?.writerId === writerId && !entry.closed && !entry.route.dispatchClosed
        ? [entry.route]
        : [],
    );
  }
  async closeWriter(...args: Parameters<SandboxBindingReader["closeWriter"]>): Promise<void> {
    // Called at the currently consumed work_finished/seal boundary. Do not wait
    // for our own future Kafka close notification while consuming this record.
    for (const entry of this.#entries.values()) {
      if (entry.route?.writerId === args[0].writerId && entry.route.tenantId === args[0].tenantId) {
        entry.closed = true;
        entry.route = { ...entry.route, dispatchClosed: true };
      }
    }
    await this.options.source.closeWriter(...args);
  }
  isAlive(instanceId: string): Promise<boolean> {
    return this.options.source.isAlive(instanceId);
  }
}
