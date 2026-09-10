import {
  InMemorySessionStorage,
  Session,
  SessionError,
  type BranchBounds,
  type Entry,
  type EntryQuery,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionStorage,
} from "@earendil-works/pi-agent-core";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import {
  committedItemSequence,
  type PiCommittedItem,
  type PiSessionAppendPublisher,
  type PiSessionMutationOperation,
  type PiSessionMutationPublisher,
} from "./session-mutation.ts";

export type NativeLaneScope = Readonly<{ lane: string; turnId: string; attemptId: string }>;
export type NativeLaneSeed = Readonly<{
  branch: readonly Entry[];
  openOperations: readonly { record: OperationStartedRecord; turnId: string | null }[];
  records?: readonly LaneRecord[];
  reader: SessionStorage;
}>;
export type NativeWriterOptions = Readonly<{
  id: string;
  metadata: SessionMetadata;
  nextSequence: number;
  lanes: readonly { lane: string; leafId: string | null }[];
  hasId(id: string): Promise<boolean>;
  waitProjected(through: number, signal?: AbortSignal): Promise<void>;
  fail(error: Error): Promise<void>;
  onViewRead?(sample: NativeViewRead): void;
}>;
export type NativeViewRead = Readonly<{
  source: "storage" | "memory";
  durationMs: number;
  storageBytes: number;
}>;

/** One ordered native append queue, shared by active Lanes; no SQL or Kafka SDK.
 * Canonical metadata is assigned here, before the durable append acknowledgement.
 */
export class NativeSessionWriter {
  readonly id: string;
  readonly metadata: SessionMetadata;
  readonly #options: NativeWriterOptions;
  readonly #lanes = new Map<string, string | null>();
  readonly #active = new Map<string, NativeLaneSessionStorage>();
  readonly #seeds = new Map<string, readonly Entry[]>();
  readonly #issued = new Set<string>();
  readonly #used = new Set<string>();
  readonly #abort = new AbortController();
  #next: number;
  #idCounter = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #failure: Error | undefined;
  #name: { value: string | undefined } | undefined;
  readonly #labels = new Map<string, string | undefined>();

  constructor(options: NativeWriterOptions) {
    this.#options = options;
    this.id = options.id;
    this.metadata = structuredClone(options.metadata);
    this.#next = options.nextSequence;
    for (const lane of options.lanes) this.#lanes.set(lane.lane, lane.leafId);
  }

  get signal() {
    return this.#abort.signal;
  }
  get activeLanes() {
    return this.#active.size;
  }
  get throughSequence() {
    return this.#next - 1;
  }
  get failed() {
    return this.#failure !== undefined;
  }
  isUnwrittenId(id: string) {
    return this.#issued.has(id);
  }
  memoryEntry(id: string) {
    for (const lane of this.#active.values()) {
      const entry = lane.committedEntry(id);
      if (entry) return entry;
    }
    return undefined;
  }
  hasWrittenId(id: string) {
    return this.#used.has(id);
  }
  observeView(sample: NativeViewRead) {
    this.#options.onViewRead?.(sample);
  }
  async name(reader: SessionStorage) {
    if (!this.#name) {
      const value = await reader.getName();
      this.#name ??= { value };
    }
    return this.#name.value;
  }
  async label(id: string, reader: SessionStorage) {
    if (!this.#labels.has(id)) {
      const value = await reader.getLabel(id);
      if (!this.#labels.has(id)) this.#labels.set(id, value);
    }
    return this.#labels.get(id);
  }
  idGenerator = (): string => {
    const id = `pc-${this.id}-${(++this.#idCounter).toString(36)}`;
    this.#issued.add(id);
    return id;
  };

  async readBarrier() {
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
  lanes() {
    return [...this.#lanes].map(([lane, leafId]) => ({ lane, leafId }));
  }
  seedFor(lane: string) {
    return this.#seeds.get(lane);
  }
  async waitProjected() {
    await this.readBarrier();
    await this.#options.waitProjected(this.throughSequence, this.signal);
  }
  release(lane: NativeLaneSessionStorage) {
    if (this.#active.get(lane.scope.lane) === lane) this.#active.delete(lane.scope.lane);
    this.#seeds.delete(lane.scope.lane);
  }
  async poison(cause: unknown) {
    if (!this.#failure) {
      this.#failure = new SessionError(
        "storage",
        "Native Session writer requires recovery",
        cause instanceof Error ? cause : undefined,
      );
      this.#abort.abort(this.#failure);
      await this.#options.fail(this.#failure);
    }
  }

  async open(scope: NativeLaneScope, seed: NativeLaneSeed, publisher: PiSessionAppendPublisher) {
    await this.readBarrier();
    if (this.#active.has(scope.lane))
      throw new SessionError("storage", "Native Lane is already active");
    const branch = this.#seeds.get(scope.lane) ?? seed.branch;
    const storage = new NativeLaneSessionStorage(this, scope, { ...seed, branch }, publisher);
    this.#active.set(scope.lane, storage);
    try {
      await storage.initialize();
    } catch (error) {
      this.release(storage);
      throw error;
    }
    return storage;
  }

  async assertUnused(id: string) {
    if (this.#used.has(id))
      throw new SessionError("already_exists", `Pi Session id already exists: ${id}`);
    // The fixed Harness uses this writer's issued namespace. External IDs (for
    // recovery/admin calls) take the cold lookup path, not ordinary Step writes.
    if (!this.#issued.has(id) && (await this.#options.hasId(id)))
      throw new SessionError("already_exists", `Pi Session id already exists: ${id}`);
  }

  append<T>(
    scope: NativeLaneSessionStorage,
    prepare: (first: number) => Promise<{ items: PiCommittedItem[]; result: T }>,
    events?: readonly PiCloudEvent[],
    onCommitted?: () => void,
  ): Promise<T> {
    const task = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      if (scope.closed) throw new SessionError("storage", "Native Lane is closed");
      let prepared: { items: PiCommittedItem[]; result: T };
      try {
        prepared = await prepare(this.#next);
      } catch (error) {
        // Validation is before publication. Restore the disposable query
        // engine after a rejected multi-item operation; no canonical state moved.
        await scope.restoreCommitted();
        throw error;
      }
      try {
        for (const [index, item] of prepared.items.entries()) {
          if (
            committedItemSequence(item) !== this.#next + index ||
            !Number.isSafeInteger(this.#next + index)
          )
            throw new Error("Native append sequence changed");
        }
        await scope.publisher.publish(structuredClone(prepared.items), events);
        for (const item of prepared.items) {
          this.#next++;
          if (item.kind === "entry") {
            this.#lanes.set(item.lane, item.entry.id);
            this.#used.add(item.entry.id);
            this.#issued.delete(item.entry.id);
          } else if (item.kind === "record") {
            this.#used.add(item.record.id);
            this.#issued.delete(item.record.id);
          } else if (item.kind === "lane") this.#lanes.set(item.lane, item.leafId);
          else if (item.fact === "name") this.#name = { value: item.name };
          else this.#labels.set(item.targetId, item.label);
        }
        await scope.committed(prepared.items);
        onCommitted?.();
        return structuredClone(prepared.result);
      } catch (error) {
        // No rollback/re-numbering after a potentially accepted publication.
        await this.poison(error);
        throw error;
      }
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async createLane(
    parent: NativeLaneSessionStorage,
    lane: string,
    at: string | null,
    branch: readonly Entry[],
  ) {
    await this.append(
      parent,
      async (seq) => {
        if (this.#lanes.has(lane))
          throw new SessionError("already_exists", "Child Lane already exists");
        if ((branch.at(-1)?.id ?? null) !== at)
          throw new SessionError("invalid_entry", "Child Lane anchor is missing");
        return {
          items: [{ kind: "lane", seq, lane, leafId: at, create: true }],
          result: undefined,
        };
      },
      undefined,
      () => this.#seeds.set(lane, structuredClone(branch)),
    );
  }
}

/** A scoped, bounded model view over the native append port. Pi's public
 * in-memory backend validates operations; its private bootstrap positions are
 * replaced with the immutable canonical stamps before any value is returned.
 */
export class NativeLaneSessionStorage implements SessionStorage {
  readonly scope: NativeLaneScope;
  readonly publisher: PiSessionAppendPublisher;
  readonly #writer: NativeSessionWriter;
  readonly #reader: SessionStorage;
  #native: InMemorySessionStorage;
  #localThrough = 0;
  #closed = false;
  #branch: Entry[];
  #baseBranch: Entry[];
  #stamps = new Map<string, Entry | LaneRecord>();
  #records: LaneRecord[] = [];
  #operationTurns = new Map<string, string | null>();
  #seedToolQueries = new Set<string>();
  #latest = new Map<string, Entry | null>();
  #completedResults = new Set<string>();
  #pendingMove: Entry[] | undefined;

  constructor(
    writer: NativeSessionWriter,
    scope: NativeLaneScope,
    seed: NativeLaneSeed,
    publisher: PiSessionAppendPublisher,
  ) {
    this.#writer = writer;
    this.scope = scope;
    this.#reader = seed.reader;
    this.publisher = publisher;
    this.#native = new InMemorySessionStorage(writer.metadata);
    this.#branch = structuredClone([...seed.branch]);
    this.#baseBranch = structuredClone([...seed.branch]);
    this.#records = [
      ...seed.openOperations.map((o) => structuredClone(o.record)),
      ...structuredClone(seed.records ?? []),
    ];
    for (const open of seed.openOperations) this.#operationTurns.set(open.record.id, open.turnId);
    for (const open of seed.openOperations) this.#seedToolQueries.add(open.record.id);
  }
  get closed() {
    return this.#closed;
  }
  get signal() {
    return this.#writer.signal;
  }
  get reader() {
    return this.#reader;
  }
  close() {
    this.#closed = true;
    this.#writer.release(this);
    this.#branch = [];
    this.#baseBranch = [];
    this.#records = [];
    this.#stamps.clear();
    this.#latest.clear();
    this.#operationTurns.clear();
    this.#seedToolQueries.clear();
    this.#completedResults.clear();
    this.#pendingMove = undefined;
    this.#native = new InMemorySessionStorage(this.#writer.metadata);
  }
  asSession() {
    return new Session(this, { idGenerator: { next: this.#writer.idGenerator } });
  }
  mutationPort(): PiSessionMutationPublisher {
    return { mutate: (operation, events) => this.mutate(operation, events) };
  }
  baseContext() {
    return structuredClone(this.#baseBranch);
  }
  committedEntry(id: string) {
    const item = this.#stamps.get(id);
    return item && "parentId" in item ? structuredClone(item as Entry) : undefined;
  }

  async initialize() {
    await this.#rebuild();
  }
  async restoreCommitted() {
    this.#pendingMove = undefined;
    await this.#rebuild();
  }
  async #rebuild() {
    const native = new InMemorySessionStorage(this.#writer.metadata);
    const stamps = new Map<string, Entry | LaneRecord>();
    for (const e of this.#branch) {
      const { parentId: _p, seq: _s, timestamp: _t, ...input } = e;
      await native.appendEntry(input, "main");
      stamps.set(e.id, e);
    }
    for (const r of this.#records) {
      const { seq: _s, timestamp: _t, ...input } = r;
      await native.appendRecord({ ...input, lane: "main" });
      stamps.set(r.id, r);
    }
    this.#localThrough = (await native.getLog()).at(-1)?.seq ?? 0;
    this.#native = native;
    this.#stamps = stamps;
  }
  #lane(lane: string) {
    if (lane !== this.scope.lane)
      throw new SessionError("invalid_lane", "Write does not belong to the active Lane");
  }
  async #ready() {
    if (this.#closed) throw new SessionError("storage", "Native Lane is closed");
    await this.#writer.readBarrier();
  }
  #stamp<T extends Entry | LaneRecord>(value: T): T {
    return structuredClone((this.#stamps.get(value.id) ?? value) as T);
  }

  async mutate(
    operation: PiSessionMutationOperation,
    events?: readonly PiCloudEvent[],
    recovery?: { entryId: string; turnId: string; recoveryId: string },
  ): Promise<unknown> {
    // Own the body before waiting for another Lane's append queue.
    operation = structuredClone(operation);
    if (operation.kind === "create_lane") {
      const at = operation.at;
      let branch: Entry[] = [];
      if (at) {
        const source = this.#baseBranch.some((e) => e.id === at) ? this.#baseBranch : this.#branch;
        const index = source.findIndex((entry) => entry.id === at);
        if (index >= 0) branch = source.slice(0, index + 1);
        else {
          await this.#writer.waitProjected();
          branch = (
            await this.#reader.findEntriesOnBranch({
              start: at,
              stopAtType: "compaction",
              order: "newestFirst",
            })
          ).reverse();
        }
      }
      return this.#writer.createLane(this, operation.lane, at, branch);
    }
    const operations = operation.kind === "append_items" ? operation.items : [operation];
    return this.#writer.append(
      this,
      async (first) => {
        const local = this.#native;
        const items: PiCommittedItem[] = [];
        const turns = new Map(this.#operationTurns);
        let open = (await local.findOpenOperations("main", { limit: 1 }))[0]?.id;
        const itemTurns: (string | null)[] = [];
        for (const op of operations) {
          if (op.kind === "append_entry") {
            this.#lane(op.lane);
            await this.#writer.assertUnused(op.entry.id);
            itemTurns.push(turns.get(open ?? "") ?? this.scope.turnId);
            await local.appendEntry(op.entry, "main");
          } else if (op.kind === "append_record") {
            this.#lane(op.record.lane);
            await this.#writer.assertUnused(op.record.id);
            if (op.record.type === "operation_started") turns.set(op.record.id, this.scope.turnId);
            itemTurns.push(
              "runId" in op.record
                ? (turns.get(op.record.runId ?? "") ?? this.scope.turnId)
                : this.scope.turnId,
            );
            await local.appendRecord({ ...op.record, lane: "main" });
            if (op.record.type === "operation_started") open = op.record.id;
            if (op.record.type === "operation_finished" && open === op.record.runId)
              open = undefined;
          } else if (op.kind === "move_lane") {
            this.#lane(op.lane);
            const index = this.#branch.findIndex((entry) => entry.id === op.to);
            this.#pendingMove =
              op.to === null
                ? []
                : index >= 0
                  ? this.#branch.slice(0, index + 1)
                  : (
                      await this.#reader.findEntriesOnBranch({
                        start: op.to,
                        stopAtType: "compaction",
                        order: "newestFirst",
                      })
                    ).reverse();
            if ((this.#pendingMove.at(-1)?.id ?? null) !== op.to)
              throw new SessionError("invalid_entry", "Native Lane target is missing");
            return {
              items: [
                { kind: "lane", seq: first, lane: this.scope.lane, leafId: op.to, create: false },
              ],
              result: undefined,
            };
          } else if (op.kind === "set_name")
            return {
              items: [{ kind: "fact", fact: "name", seq: first, name: op.name }],
              result: undefined,
            };
          else if (op.kind === "set_label") {
            if (!this.#writer.memoryEntry(op.id) && !(await this.#reader.getEntry(op.id)))
              throw new SessionError("invalid_entry", "Native Label target is missing");
            return {
              items: [
                { kind: "fact", fact: "label", seq: first, targetId: op.id, label: op.label },
              ],
              result: undefined,
            };
          } else throw new SessionError("storage", "Unsupported native operation");
        }
        const log = await local.getLog({ afterSeq: this.#localThrough });
        for (const [index, item] of log.entries()) {
          const seq = first + index;
          if (item.kind === "entry") {
            const turnId = itemTurns[index] ?? this.scope.turnId;
            items.push({
              kind: "entry",
              lane: this.scope.lane,
              entry: { ...item.entry, seq },
              turnId,
              ...(recovery?.entryId === item.entry.id
                ? { turnId: recovery.turnId, recoveryId: recovery.recoveryId }
                : {}),
            });
          } else if (item.kind === "record") {
            const record = { ...item.record, seq, lane: this.scope.lane };
            const turnId = itemTurns[index] ?? this.scope.turnId;
            items.push({ kind: "record", record, turnId });
          } else if (item.kind === "lane")
            items.push({ ...item, seq, lane: this.scope.lane, create: false });
          else items.push({ ...item, seq });
        }
        this.#localThrough = log.at(-1)?.seq ?? this.#localThrough;
        const values = items.flatMap<Entry | LaneRecord>((item) =>
          item.kind === "entry" ? [item.entry] : item.kind === "record" ? [item.record] : [],
        );
        return { items, result: operation.kind === "append_items" ? { items: values } : values[0] };
      },
      events,
    );
  }

  async committed(items: readonly PiCommittedItem[]) {
    if (this.#closed) return;
    let rebuild = false;
    for (const item of items) {
      if (item.kind === "entry" && item.lane === this.scope.lane) {
        const e = item.entry;
        if (e.type === "compaction") {
          this.#branch = [];
          this.#seedToolQueries.clear();
          rebuild = true;
        }
        this.#branch.push(e);
        this.#stamps.set(e.id, e);
        if (e.type === "message" && e.message.role === "toolResult")
          this.#completedResults.add(e.id);
        if (e.type === "custom") this.#latest.set(e.customType, e);
      } else if (item.kind === "record" && item.record.lane === this.scope.lane) {
        const r = item.record;
        if (
          r.type === "operation_started" &&
          r.intent.kind === "run" &&
          item.turnId === this.scope.turnId
        )
          this.#baseBranch = this.#branch.slice();
        this.#records.push(r);
        this.#stamps.set(r.id, r);
        if (r.type === "operation_started") this.#operationTurns.set(r.id, item.turnId);
      } else if (item.kind === "lane" && !item.create && item.lane === this.scope.lane) {
        this.#branch = this.#pendingMove!;
        this.#pendingMove = undefined;
        this.#latest.clear();
        rebuild = true;
      }
    }
    if (rebuild) {
      const finished = new Set(
        this.#records.filter((r) => r.type === "operation_finished").map((r) => r.runId),
      );
      this.#records = this.#records.filter(
        (r) =>
          r.type === "step_attempt" ||
          (r.type === "operation_started" && !finished.has(r.id)) ||
          (r.type === "tool_started" &&
            !this.#completedResults.has(r.resultEntryId) &&
            !finished.has(r.runId)),
      );
      await this.#rebuild();
    }
  }

  appendEntry<T extends Entry>(entry: ProvisionedEntry<T>, lane: string): Promise<T> {
    return this.mutate({
      kind: "append_entry",
      entry: entry as ProvisionedEntry<Entry>,
      lane,
    }) as Promise<T>;
  }
  async appendRecovery(entry: ProvisionedEntry<Entry>, turnId: string, recoveryId: string) {
    await this.mutate({ kind: "append_entry", lane: this.scope.lane, entry }, undefined, {
      entryId: entry.id,
      turnId,
      recoveryId,
    });
  }
  appendRecord<T extends LaneRecord>(record: NewRecord<T>): Promise<T> {
    return this.mutate({
      kind: "append_record",
      record: record as NewRecord<LaneRecord>,
    }) as Promise<T>;
  }
  createLane(lane: string, at: string | null) {
    return this.mutate({ kind: "create_lane", lane, at }).then(() => {});
  }
  moveLane(lane: string, to: string | null) {
    return this.mutate({ kind: "move_lane", lane, to }).then(() => {});
  }
  setName(name: string) {
    return this.mutate({ kind: "set_name", name }).then(() => {});
  }
  setLabel(id: string, label: string | undefined) {
    return this.mutate({ kind: "set_label", id, ...(label === undefined ? {} : { label }) }).then(
      () => {},
    );
  }
  async getMetadata() {
    await this.#ready();
    return structuredClone(this.#writer.metadata);
  }
  async getLanes() {
    await this.#ready();
    return this.#writer.lanes();
  }
  async getEntry(id: string) {
    await this.#ready();
    const value = this.#writer.memoryEntry(id);
    if (value) return value;
    if (this.#writer.isUnwrittenId(id)) return undefined;
    if (this.#writer.hasWrittenId(id)) await this.#writer.waitProjected();
    return this.#reader.getEntry(id);
  }
  async getName() {
    await this.#ready();
    return this.#writer.name(this.#reader);
  }
  async getLabel(id: string) {
    await this.#ready();
    return this.#writer.label(id, this.#reader);
  }
  async getStats() {
    await this.#writer.waitProjected();
    return this.#reader.getStats();
  }
  async getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]> {
    await this.#writer.waitProjected();
    return this.#reader.getLog(options);
  }
  async findEntries(query?: EntryQuery) {
    await this.#writer.waitProjected();
    return this.#reader.findEntries(query);
  }
  async findEntriesOnBranch(
    query: EntryQuery & BranchBounds & { start: string },
  ): Promise<Entry[]> {
    await this.#ready();
    const started = performance.now();
    const index = this.#branch.findIndex((e) => e.id === query.start);
    const latestCustomAtHead =
      index === this.#branch.length - 1 &&
      query.limit === 1 &&
      query.customType !== undefined &&
      (query.type === undefined || query.type === "custom") &&
      query.cursor === undefined &&
      query.stopAtId === undefined &&
      query.stopAtType === undefined;
    if (
      index >= 0 &&
      query.order !== "oldestFirst" &&
      (query.stopAtType === "compaction" || latestCustomAtHead)
    ) {
      let path = this.#branch.slice(0, index + 1).reverse();
      const stop = path.findIndex((e) => e.id === query.stopAtId || e.type === query.stopAtType);
      if (stop >= 0) path = path.slice(0, stop + 1);
      path = path.filter(
        (e) =>
          (query.type === undefined || e.type === query.type) &&
          (query.customType === undefined ||
            (e.type === "custom" && e.customType === query.customType)) &&
          (!query.cursor || e.seq < query.cursor.afterSeq),
      );
      if (query.limit) path = path.slice(0, query.limit);
      if (path.length || query.stopAtType === "compaction") {
        const snapshot = structuredClone(path);
        if (query.stopAtType === "compaction")
          this.#writer.observeView({
            source: "memory",
            durationMs: performance.now() - started,
            storageBytes: 0,
          });
        return snapshot;
      }
      const key = query.customType!;
      if (!this.#latest.has(key)) {
        // Only the unseen ancestry before this bounded branch remains. The
        // original Run base may now be on another branch after moveLane().
        const base = this.#branch[0]?.parentId;
        if (base && this.#writer.hasWrittenId(base)) await this.#writer.waitProjected();
        this.#latest.set(
          key,
          base
            ? ((await this.#reader.findEntriesOnBranch({ ...query, start: base }))[0] ?? null)
            : null,
        );
      }
      const entry = this.#latest.get(key);
      return entry ? [structuredClone(entry)] : [];
    }
    await this.#writer.waitProjected();
    return this.#reader.findEntriesOnBranch(query);
  }
  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}) {
    await this.#ready();
    if (
      query.runId &&
      ((query.type === "step_attempt" &&
        this.#operationTurns.get(query.runId) === this.scope.turnId) ||
        (query.type === "tool_started" && this.#seedToolQueries.has(query.runId)))
    ) {
      let records = this.#records.filter(
        (r) =>
          (!query.type || r.type === query.type) &&
          "runId" in r &&
          r.runId === query.runId &&
          (!query.lane || r.lane === query.lane) &&
          (!query.afterSeq || r.seq > query.afterSeq),
      );
      if (query.order !== "oldestFirst") records = records.slice().reverse();
      return structuredClone(query.limit ? records.slice(0, query.limit) : records);
    }
    await this.#writer.waitProjected();
    return this.#reader.findRecords(query);
  }
  async findOpenOperations(lane: string, options?: { limit?: number }) {
    await this.#ready();
    this.#lane(lane);
    return (await this.#native.findOpenOperations("main", options)).map((r) => this.#stamp(r));
  }
}
