import {
  InMemorySessionStorage,
  Session,
  type SessionStorage,
  type SessionMetadata,
  type Entry,
  type LaneRecord,
  type ProvisionedEntry,
  type NewRecord,
  type LogItem,
  type EntryQuery,
  type BranchBounds,
  type RecordQuery,
  type LogOptions,
} from "@earendil-works/pi-agent-core";
import type { PiSessionAppendOperation } from "../../packages/pi-session-postgres/src/session-mutation.ts";
import assert from "node:assert/strict";

export type NativeItem = LogItem & { lane?: string };
export type NativeAppend = {
  kind: "append";
  id: string;
  sessionId: string;
  writerId: string;
  items: NativeItem[];
};
export type NativeSeal = {
  kind: "seal";
  id: string;
  sessionId: string;
  writerId: string;
  through: number;
};
export type NativeFact = NativeAppend | NativeSeal;
export type DurableAppend = (fact: NativeFact) => Promise<void>;

/** Experiment only. Pi owns mutation semantics, the adapter owns the ACK boundary.
 * One instance is shared by every active Lane of one physical Session.
 */
export class KafkaAckSessionStorage implements SessionStorage {
  readonly #native: InMemorySessionStorage;
  readonly #publish: DurableAppend;
  readonly #writerId: string;
  readonly #metadata: SessionMetadata;
  readonly #originalTimestamps = new Map<string, number>();
  #tail: Promise<unknown> = Promise.resolve();
  #through = 0;
  #failed: Error | undefined;
  #sealed = false;

  constructor(metadata: SessionMetadata, writerId: string, publish: DurableAppend) {
    this.#metadata = metadata;
    this.#writerId = writerId;
    this.#publish = publish;
    this.#native = new InMemorySessionStorage(metadata);
  }

  asSession() {
    return new Session(this);
  }

  async #read<T>(read: () => Promise<T>): Promise<T> {
    await this.#tail;
    if (this.#failed) throw this.#failed;
    return read();
  }

  #stamp<T extends Entry | LaneRecord>(value: T): T {
    return { ...value, timestamp: this.#originalTimestamps.get(value.id) ?? value.timestamp };
  }

  #write<T>(write: () => Promise<T>, entryLanes = new Map<string, string>()): Promise<T> {
    const work = this.#tail.then(async () => {
      if (this.#failed) throw this.#failed;
      if (this.#sealed) throw new Error("Session writer is sealed");
      let publishing = false;
      try {
        const result = await write();
        const items = (await this.#native.getLog({ afterSeq: this.#through })).map((item) =>
          item.kind === "entry" ? { ...item, lane: entryLanes.get(item.entry.id)! } : item,
        );
        publishing = true;
        await this.#publish({
          kind: "append",
          id: crypto.randomUUID(),
          sessionId: this.#metadata.id,
          writerId: this.#writerId,
          items,
        });
        this.#through = items.at(-1)?.seq ?? this.#through;
        return result;
      } catch (error) {
        // A rejected validation without mutation is recoverable. A partial batch
        // or a possibly accepted publication is not safe to roll back/retry.
        if (publishing || (await this.#native.getLog({ afterSeq: this.#through })).length) {
          this.#failed = new Error("Session writer requires recovery after an uncertain append", {
            cause: error,
          });
        }
        throw error;
      }
    });
    this.#tail = work.catch(() => undefined);
    return work;
  }

  async seal() {
    const work = this.#tail.then(async () => {
      if (this.#failed) throw this.#failed;
      if (this.#sealed) throw new Error("Session writer is sealed");
      this.#sealed = true;
      await this.#publish({
        kind: "seal",
        id: crypto.randomUUID(),
        sessionId: this.#metadata.id,
        writerId: this.#writerId,
        through: this.#through,
      });
    });
    this.#tail = work.catch(() => undefined);
    return work;
  }

  appendEntry<T extends Entry>(entry: ProvisionedEntry<T>, lane: string): Promise<T> {
    return this.#write(() => this.#native.appendEntry(entry, lane), new Map([[entry.id, lane]]));
  }
  appendRecord<T extends LaneRecord>(record: NewRecord<T>): Promise<T> {
    return this.#write(() => this.#native.appendRecord(record));
  }
  appendItems(items: readonly PiSessionAppendOperation[]) {
    return this.#write(
      async () => {
        const results: (Entry | LaneRecord)[] = [];
        for (const item of items)
          results.push(
            item.kind === "append_entry"
              ? await this.#native.appendEntry(item.entry, item.lane)
              : await this.#native.appendRecord(item.record),
          );
        return { items: results };
      },
      new Map(
        items.flatMap((item) => (item.kind === "append_entry" ? [[item.entry.id, item.lane]] : [])),
      ),
    );
  }
  createLane(lane: string, at: string | null) {
    return this.#write(() => this.#native.createLane(lane, at));
  }
  moveLane(lane: string, to: string | null) {
    return this.#write(() => this.#native.moveLane(lane, to));
  }
  setName(name: string) {
    return this.#write(() => this.#native.setName(name));
  }
  setLabel(id: string, label: string | undefined) {
    return this.#write(() => this.#native.setLabel(id, label));
  }
  getMetadata() {
    return this.#read(() => this.#native.getMetadata());
  }
  getLanes() {
    return this.#read(() => this.#native.getLanes());
  }
  getName() {
    return this.#read(() => this.#native.getName());
  }
  getLabel(id: string) {
    return this.#read(() => this.#native.getLabel(id));
  }
  getStats() {
    return this.#read(() => this.#native.getStats());
  }
  getEntry(id: string) {
    return this.#read(async () => {
      const e = await this.#native.getEntry(id);
      return e && this.#stamp(e);
    });
  }
  findEntries(query?: EntryQuery) {
    return this.#read(async () =>
      (await this.#native.findEntries(query)).map((e) => this.#stamp(e)),
    );
  }
  findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }) {
    return this.#read(async () =>
      (await this.#native.findEntriesOnBranch(query)).map((e) => this.#stamp(e)),
    );
  }
  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  findRecords(query?: RecordQuery) {
    return this.#read(async () =>
      (await this.#native.findRecords(query)).map((r) => this.#stamp(r)),
    );
  }
  findOpenOperations(lane: string, options?: { limit?: number }) {
    return this.#read(async () =>
      (await this.#native.findOpenOperations(lane, options)).map((r) => this.#stamp(r)),
    );
  }
  getLog(options?: LogOptions) {
    return this.#read(async () =>
      (await this.#native.getLog(options)).map((item) =>
        item.kind === "entry"
          ? { ...item, entry: this.#stamp(item.entry) }
          : item.kind === "record"
            ? { ...item, record: this.#stamp(item.record) }
            : item,
      ),
    );
  }

  /** Small fixture replay only: no claim of bounded production snapshot import. */
  static async restore(
    metadata: SessionMetadata,
    writerId: string,
    publish: DurableAppend,
    items: readonly NativeItem[],
  ) {
    const storage = new KafkaAckSessionStorage(metadata, writerId, publish);
    for (const item of items) {
      if (item.kind === "entry") {
        const { seq, parentId, timestamp, ...input } = item.entry;
        const restored = await storage.#native.appendEntry(input, item.lane!);
        storage.#originalTimestamps.set(restored.id, timestamp);
        assert.deepEqual(storage.#stamp(restored), item.entry);
      } else if (item.kind === "record") {
        const { seq, timestamp, ...input } = item.record;
        const restored = await storage.#native.appendRecord(input);
        storage.#originalTimestamps.set(restored.id, timestamp);
        assert.deepEqual(storage.#stamp(restored), item.record);
      } else if (item.kind === "lane") {
        const exists = (await storage.#native.getLanes()).some((lane) => lane.lane === item.lane);
        if (exists) await storage.#native.moveLane(item.lane!, item.leafId);
        else await storage.#native.createLane(item.lane!, item.leafId);
      } else if (item.fact === "name") await storage.#native.setName(item.name);
      else await storage.#native.setLabel(item.targetId, item.label);
      const [last] = await storage.#native.getLog({ afterSeq: storage.#through });
      assert.equal(last?.seq, item.seq);
      storage.#through = item.seq;
    }
    return storage;
  }
}
