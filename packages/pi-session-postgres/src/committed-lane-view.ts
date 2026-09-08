import type { Entry } from "@earendil-works/pi-agent-core";
import type {
  PiSessionAppendOperation,
  PiSessionMutationOperation,
  PiSessionMutationPublisher,
} from "./session-mutation.ts";

export type LaneViewRead = Readonly<{
  source: "storage" | "memory";
  entries: number;
  durationMs: number;
  storageBytes: number;
}>;

/** A disposable read materialization, never a writer or a second Session log. */
export class CommittedLaneView {
  readonly #lane: string;
  readonly #readBranch: () => Promise<Entry[]>;
  readonly #observe: ((sample: LaneViewRead) => void) | undefined;
  #path: Entry[] | undefined;
  #ids = new Set<string>();
  #generation = 0;
  #loading: Promise<void> | undefined;
  #closed = false;
  #storageReads = 0;
  #memoryReads = 0;
  #storageBytes = 0;
  #updates = 0;

  constructor(options: {
    lane: string;
    readBranch: () => Promise<Entry[]>;
    onRead?: (sample: LaneViewRead) => void;
  }) {
    this.#lane = options.lane;
    this.#readBranch = options.readBranch;
    this.#observe = options.onRead;
  }

  publisher(delegate: PiSessionMutationPublisher): PiSessionMutationPublisher {
    return {
      mutate: async (operation, events) => {
        const result = await delegate.mutate(operation, events);
        this.committed(operation, result);
        return result;
      },
    };
  }

  committed(operation: PiSessionMutationOperation, result: unknown): void {
    if (this.#closed) return;
    if (operation.kind === "move_lane" && operation.lane === this.#lane) this.reset();
    if (operation.kind === "append_entry") this.#append(operation, result);
    if (operation.kind === "append_items") {
      const items = (result as { items?: unknown[] } | null)?.items;
      if (!Array.isArray(items) || items.length !== operation.items.length) {
        this.reset();
        return;
      }
      operation.items.forEach((item, i) => {
        if (item.kind === "append_entry") this.#append(item, items[i]);
      });
    }
  }

  #append(
    operation: Extract<PiSessionAppendOperation, { kind: "append_entry" }>,
    value: unknown,
  ): void {
    if (operation.lane !== this.#lane) return;
    this.#generation++;
    if (!this.#path) return;
    const entry = value as Entry | undefined;
    if (
      !entry ||
      typeof entry.id !== "string" ||
      entry.type !== operation.entry.type ||
      (operation.entry.id !== undefined && entry.id !== operation.entry.id)
    ) {
      this.reset();
      return;
    }
    if (this.#ids.has(entry.id)) return; // idempotent receipt, never move the head backwards
    if (entry.parentId !== (this.#path.at(-1)?.id ?? null)) {
      this.reset();
      return;
    }
    if (entry.type === "compaction") {
      this.#path = [];
      this.#ids.clear();
    }
    this.#path.push(structuredClone(entry));
    this.#ids.add(entry.id);
    this.#updates++;
  }

  async read(): Promise<Entry[]> {
    if (this.#closed) throw new Error("Lane execution view is closed");
    const started = performance.now();
    const source = this.#path ? "memory" : "storage";
    while (!this.#path) {
      if (this.#closed) throw new Error("Lane execution view is closed");
      this.#loading ??= this.#load().finally(() => {
        this.#loading = undefined;
      });
      await this.#loading;
    }
    if (this.#closed) throw new Error("Lane execution view is closed");
    // A model transform may mutate its messages. Never expose cache references.
    const path = structuredClone(this.#path!);
    if (source === "memory") {
      this.#memoryReads++;
      this.#observe?.({
        source,
        entries: path.length,
        durationMs: performance.now() - started,
        storageBytes: 0,
      });
    }
    return path;
  }

  async #load(): Promise<void> {
    for (;;) {
      const generation = this.#generation;
      const started = performance.now();
      const path = await this.#readBranch();
      this.#storageReads++;
      const storageBytes = Buffer.byteLength(JSON.stringify(path));
      this.#storageBytes += storageBytes;
      this.#observe?.({
        source: "storage",
        entries: path.length,
        durationMs: performance.now() - started,
        storageBytes,
      });
      if (this.#closed) throw new Error("Lane execution view is closed");
      if (generation !== this.#generation) continue;
      this.#path = structuredClone(path);
      this.#ids = new Set(path.map((entry) => entry.id));
      return;
    }
  }

  reset(): void {
    this.#generation++;
    this.#path = undefined;
    this.#ids.clear();
  }
  close(): void {
    this.#closed = true;
    this.reset();
  }
  statistics() {
    return {
      storageReads: this.#storageReads,
      memoryReads: this.#memoryReads,
      storageBytes: this.#storageBytes,
      updates: this.#updates,
      retainedEntries: this.#path?.length ?? 0,
    };
  }
}
