import type { Context, JsonValue } from "@earendil-works/chord";
import {
  StorageRejected,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentCreate,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { PublicationNotSentError, NATIVE_HUMAN_INPUT_DOCUMENT } from "@pi-cloud/protocol";
import { DurablePostgresProjection, materializeNativeDocument } from "./postgres-projection.ts";
import {
  cloneNative,
  currentOnly,
  documentAddress,
  documentScope,
  indexNative,
  matchesRecord,
  type DocumentRevision,
  type DurableBatch,
  type IndexedRecord,
  type NativeRecord,
  type RecordQuery,
} from "./types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; retire: boolean };
type Prepared = {
  batch: DurableBatch;
  records: IndexedRecord[];
  revisions: DocumentRevision[];
  resetRevisions: Set<number>;
  retiredCurrent: Set<number>;
  inputConversations: number[];
};
export type DurableStorageOptions = {
  projection: DurablePostgresProjection;
  publish(batch: DurableBatch, inputConversations?: readonly number[]): Promise<void>;
  waitProjected(through: number): Promise<void>;
  assertCurrent?(): Promise<void>;
  maximumBufferedWrites?: number;
  maximumBufferedBytes?: number;
};
const cursorId = (cursor: Cursor | undefined): number | undefined => {
  if (cursor?.after === undefined) return undefined;
  if (typeof cursor.after !== "number" || !Number.isSafeInteger(cursor.after) || cursor.after < 0)
    throw new TypeError("Invalid storage cursor");
  return cursor.after;
};
function page<T extends { readonly id: number }>(values: T[], limit: number): Page<T, Cursor> {
  return {
    items: cloneNative(values.slice(0, limit)),
    ...(values.length > limit ? { next: { after: values[limit - 1]!.id } } : {}),
  };
}

/** One PG-authorized owner, one atomic publication stream. The overlay is only
 * acknowledged state waiting for PG projection. It is never a second history or
 * an operation-result ledger; a cold open queries the indexed native records. */
export class PublishedDurableStorage implements Storage {
  readonly #options: DurableStorageOptions;
  readonly #records = new Map<number, IndexedRecord>();
  readonly #revisions = new Map<number, DocumentRevision[]>();
  readonly #revisionResets = new Set<number>();
  readonly #readCache = new Map<number, IndexedRecord | undefined>();
  #seq: number;
  #nextId: number;
  #coldSeq: number;
  #coldNextId: number;
  readonly #addresses = new Map<string, DocumentRecord | undefined>();
  #bufferedWrites = 0;
  #bufferedBytes = 0;
  #closed = false;
  #failed: unknown;
  #tail: Promise<unknown> = Promise.resolve();
  private constructor(options: DurableStorageOptions, head: { seq: number; nextId: number }) {
    this.#options = options;
    this.#seq = head.seq;
    this.#nextId = head.nextId;
    this.#coldSeq = head.seq;
    this.#coldNextId = head.nextId;
  }
  static async open(options: DurableStorageOptions): Promise<PublishedDurableStorage> {
    return new PublishedDurableStorage(options, await options.projection.head());
  }
  get committedSequence(): number {
    return this.#seq;
  }
  recordSequence(id: number): Promise<number | undefined> {
    return this.#serial(async () => (await this.#get(id))?.seq);
  }
  get bufferedWrites(): number {
    return this.#bufferedWrites;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("Durable storage is closed");
    if (this.#failed)
      throw new Error("Durable storage owner failed after uncertain publication", {
        cause: this.#failed,
      });
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      this.#assertOpen();
      return work();
    });
    this.#tail = result.catch(() => {});
    return result;
  }
  async mintId<I extends Id<string>>(): Promise<I> {
    this.#assertOpen();
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
    return this.#nextId++ as I;
  }
  commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    // Detach on admission, before any await lets the caller change retained data.
    const detached = cloneNative(writes);
    return this.#serial(async () => {
      await this.#options.assertCurrent?.();
      if (
        this.#bufferedWrites >= (this.#options.maximumBufferedWrites ?? 2048) ||
        this.#bufferedBytes >= (this.#options.maximumBufferedBytes ?? 16 * 1024 * 1024)
      )
        await this.#flush();
      const prepared = await this.#prepare(detached);
      await this.#options.assertCurrent?.();
      try {
        await this.#options.publish(cloneNative(prepared.batch), prepared.inputConversations);
      } catch (error) {
        if (error instanceof PublicationNotSentError || error instanceof StorageRejected)
          throw new StorageRejected(error.message, { cause: error });
        this.#failed = error;
        throw error;
      }
      // All fallible validation and materialization happened before publication.
      for (const record of prepared.records) this.#records.set(record.value.id, record);
      for (const id of prepared.resetRevisions) {
        this.#revisions.delete(id);
        this.#revisionResets.add(id);
      }
      for (const revision of prepared.revisions) {
        const revisions = this.#revisions.get(revision.id) ?? [];
        revisions.push(revision);
        this.#revisions.set(revision.id, revisions);
      }
      for (const id of prepared.retiredCurrent) {
        this.#revisions.delete(id);
        this.#revisionResets.add(id);
      }
      this.#seq = prepared.batch.seq;
      this.#nextId = Math.max(this.#nextId, prepared.batch.nextId);
      this.#bufferedWrites += Math.max(1, prepared.batch.writes.length);
      this.#bufferedBytes += Buffer.byteLength(JSON.stringify(prepared.batch));
      const changedAddresses = new Set<string>();
      for (const record of prepared.records) {
        this.#readCache.delete(record.value.id);
        if (record.kind === "document") changedAddresses.add(record.fields.address!);
      }
      for (const address of changedAddresses) {
        const current = [...this.#records.values()].find(
          (r) =>
            r.kind === "document" && r.fields.address === address && r.retiredSeq === undefined,
        );
        if (this.#addresses.size >= 128 && !this.#addresses.has(address))
          this.#addresses.delete(this.#addresses.keys().next().value!);
        this.#addresses.set(address, current?.value as DocumentRecord | undefined);
      }
      return prepared.batch.seq;
    });
  }
  /** Host eviction and tests can explicitly drain the same projection watermark. */
  flush(): Promise<void> {
    return this.#serial(() => this.#flush());
  }
  async #flush(): Promise<void> {
    if (!this.#bufferedWrites) return;
    await this.#options.waitProjected(this.#seq);
    this.#assertOpen();
    this.#records.clear();
    this.#revisions.clear();
    this.#revisionResets.clear();
    this.#readCache.clear();
    this.#addresses.clear();
    this.#coldSeq = this.#seq;
    this.#coldNextId = this.#nextId;
    this.#bufferedBytes = 0;
    this.#bufferedWrites = 0;
  }
  async #get(id: number): Promise<IndexedRecord | undefined> {
    const local = this.#records.get(id);
    if (local) return local;
    if (this.#coldSeq === 0 || id >= this.#coldNextId) return undefined;
    if (this.#readCache.has(id)) return this.#readCache.get(id);
    const record = await this.#options.projection.get(id);
    // Large transcript/image bodies belong to the native working set, not a
    // second unbounded read cache. Bound both entry count and retained bytes.
    if (record === undefined || Buffer.byteLength(JSON.stringify(record)) <= 128 * 1024) {
      if (this.#readCache.size >= 128) this.#readCache.delete(this.#readCache.keys().next().value!);
      this.#readCache.set(id, record);
    }
    return record;
  }
  async #scan(query: RecordQuery, limit: number): Promise<IndexedRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError("Storage scan limit must be positive");
    const cold =
      this.#coldSeq === 0 || (query.minId !== undefined && query.minId >= this.#coldNextId)
        ? []
        : await this.#options.projection.scan(query, limit, [...this.#records.keys()]);
    const local = [...this.#records.values()].filter((record) => matchesRecord(record, query));
    return [...cold, ...local]
      .sort((a, b) => (query.descending ? b.value.id - a.value.id : a.value.id - b.value.id))
      .slice(0, limit);
  }
  async #record<T extends NativeRecord>(
    id: number,
    kind: IndexedRecord["kind"],
  ): Promise<T | undefined> {
    const record = await this.#get(id);
    return record?.kind === kind ? (record.value as T) : undefined;
  }
  async #conversation(id: ConversationId): Promise<ConversationRecord> {
    const record = await this.#record<ConversationRecord>(id, "conversation");
    if (!record) throw new Error(`Unknown conversation: ${id}`);
    return record;
  }
  conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.#serial(
      async () =>
        cloneNative((await this.#record<ConversationRecord>(id, "conversation")) ?? null) ??
        undefined,
    );
  }
  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.#serial(async () => {
      const fields: Record<string, string> = {};
      if (query.ownerConversationId !== undefined)
        fields.ownerConversation = String(query.ownerConversationId);
      if (query.ownerTaskId !== undefined) fields.ownerTask = String(query.ownerTaskId);
      const rows = await this.#scan(
        { kind: "conversation", fields, minId: (cursorId(cursor) ?? -1) + 1 },
        limit + 1,
      );
      return page(
        rows.map((r) => r.value as ConversationRecord),
        limit,
      );
    });
  }
  entry(id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    idOrConversation: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
    return this.#serial(async () => {
      const id = context === undefined ? idOrConversation : idOrContext;
      if (typeof id !== "number") throw new TypeError("Storage.entry() requires an entry ID");
      let conversation =
        context === undefined
          ? undefined
          : await this.#conversation(idOrConversation as ConversationId);
      const record = await this.#get(id);
      if (!record || record.kind !== "entry") return undefined;
      const entry = record.value as EntryRecord;
      let upper = Number.MAX_SAFE_INTEGER;
      const visited = new Set<number>();
      while (conversation && conversation.id !== entry.conversationId) {
        if (visited.has(conversation.id))
          throw new Error("Native conversation ancestry has a cycle");
        visited.add(conversation.id);
        if (!conversation.parent) return undefined;
        upper = Math.min(upper, conversation.parent.at);
        conversation = await this.#conversation(conversation.parent.conversationId);
      }
      return entry.id > upper
        ? undefined
        : { entry: cloneNative(entry), commitSeq: record.seq as Seq };
    });
  }
  async #entries(
    query: EntryQuery,
    limit: number,
    cursor?: Cursor,
    head = false,
  ): Promise<EntryRecord[]> {
    let conversation = await this.#conversation(query.conversationId);
    let upper = Math.min(
      query.maxEntryId ?? Number.MAX_SAFE_INTEGER,
      (cursorId(cursor) ?? Number.MAX_SAFE_INTEGER + 1) - 1,
    );
    const values: EntryRecord[] = [],
      visited = new Set<number>();
    while (true) {
      if (visited.has(conversation.id)) throw new Error("Native conversation ancestry has a cycle");
      visited.add(conversation.id);
      const rows = await this.#scan(
        {
          kind: "entry",
          fields: { conversation: String(conversation.id) },
          maxId: upper,
          minId: query.minEntryId ?? 0,
          descending: true,
          head,
        },
        limit - values.length,
      );
      values.push(...rows.map((r) => r.value as EntryRecord));
      if (values.length >= limit || !conversation.parent) break;
      upper = Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = await this.#conversation(conversation.parent.conversationId);
    }
    return values;
  }
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { head: EntryId }) | undefined> {
    return this.#serial(async () => {
      const rows = await this.#entries(
        {
          conversationId,
          ...(atOrBeforeEntryId === undefined ? {} : { maxEntryId: atOrBeforeEntryId }),
        },
        1,
        undefined,
        true,
      );
      return rows[0] ? (cloneNative(rows[0]) as EntryRecord & { head: EntryId }) : undefined;
    });
  }
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.#serial(async () => page(await this.#entries(query, limit + 1, cursor), limit));
  }
  task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    return this.#serial(
      async () => cloneNative((await this.#record<StoredTask>(id, "task")) ?? null) ?? undefined,
    );
  }
  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    return this.#serial(async () => {
      const fields: Record<string, string> = {};
      if (query.conversationId !== undefined) fields.conversation = String(query.conversationId);
      if (query.kind !== undefined) fields.nativeKind = JSON.stringify(query.kind);
      if (query.status !== undefined) fields.status = query.status;
      if (query.abortRequested !== undefined) fields.abortRequested = String(query.abortRequested);
      if (query.background !== undefined) fields.background = String(query.background);
      return page(
        (
          await this.#scan({ kind: "task", fields, minId: (cursorId(cursor) ?? -1) + 1 }, limit + 1)
        ).map((r) => r.value as StoredTask),
        limit,
      );
    });
  }
  submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.#serial(
      async () =>
        cloneNative((await this.#record<SubmissionRecord>(id, "submission")) ?? null) ?? undefined,
    );
  }
  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.#serial(async () => {
      const fields: Record<string, string> = {};
      if (query.conversationId !== undefined) fields.conversation = String(query.conversationId);
      if (query.status !== undefined) fields.status = query.status;
      return page(
        (
          await this.#scan(
            { kind: "submission", fields, minId: (cursorId(cursor) ?? -1) + 1 },
            limit + 1,
          )
        ).map((r) => r.value as SubmissionRecord),
        limit,
      );
    });
  }
  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.#serial(async () => {
      const rows = await this.#scan(
        {
          kind: "submission",
          fields: { conversation: String(conversationId), request: JSON.stringify(requestId) },
        },
        1,
      );
      return rows[0] ? (cloneNative(rows[0].value) as SubmissionRecord) : undefined;
    });
  }
  async #findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
  ): Promise<DocumentRecord | undefined> {
    const key = documentAddress(address);
    if (at === "current") {
      if (this.#addresses.has(key)) return this.#addresses.get(key);
      const local = [...this.#records.values()].find(
        (r) => r.kind === "document" && r.fields.address === key && r.retiredSeq === undefined,
      );
      if (local) return local.value as DocumentRecord;
    }
    const rows = await this.#scan(
      { kind: "document", fields: { address: documentAddress(address) }, at, descending: true },
      1,
    );
    const record = rows[0]?.value as DocumentRecord | undefined;
    if (at === "current") {
      if (this.#addresses.size >= 128) this.#addresses.delete(this.#addresses.keys().next().value!);
      this.#addresses.set(key, record);
    }
    return record;
  }
  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    return this.#serial(
      async () => cloneNative((await this.#findDocument(address, at)) ?? null) ?? undefined,
    );
  }
  async #document(id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const record = await this.#record<DocumentRecord>(id, "document");
    if (!record) return undefined;
    if (at !== "current" && currentOnly(record))
      throw new Error(`Document ${id} does not retain historical content`);
    if (
      at === "current"
        ? record.retiredAt !== undefined
        : record.createdAt > at || (record.retiredAt !== undefined && record.retiredAt <= at)
    )
      return undefined;
    const through = at === "current" ? this.#seq : at;
    const local = (this.#revisions.get(id) ?? []).filter((r) => r.seq <= through);
    // A local base and every later acknowledged write belong to this writer.
    // Historical points before that base (or an evicted base) still need PG.
    const completeLocal = local.some((revision) => revision.content.kind === "base");
    const cold =
      this.#revisionResets.has(id) || completeLocal
        ? []
        : await this.#options.projection.revisions(id, through);
    const bySequence = new Map(cold.map((r) => [r.seq, r]));
    for (const revision of local)
      if (bySequence.get(revision.seq)?.checkpoint === undefined)
        bySequence.set(revision.seq, revision);
    return cloneNative(
      materializeNativeDocument(
        record,
        [...bySequence.values()].sort((a, b) => a.seq - b.seq),
      ),
    );
  }
  document(
    id: DocumentId,
    at: DocumentPoint,
    _context: Context,
  ): Promise<StoredDocument | undefined> {
    return this.#serial(() => this.#document(id, at));
  }
  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.#serial(async () => {
      const fields: Record<string, string> = { scope: documentScope(query.scope) };
      if (query.kind !== undefined) fields.nativeKind = JSON.stringify(query.kind);
      return page(
        (
          await this.#scan(
            { kind: "document", fields, at: query.at, minId: (cursorId(cursor) ?? -1) + 1 },
            limit + 1,
          )
        ).map((r) => r.value as DocumentRecord),
        limit,
      );
    });
  }
  async close(_context: Context): Promise<void> {
    await this.#tail;
    this.#closed = true;
    this.#records.clear();
    this.#revisions.clear();
    this.#readCache.clear();
  }
  async #latestRevision(id: number): Promise<{ version: number; deltaCount: number } | undefined> {
    const local = this.#revisions.get(id)?.at(-1);
    if (local) return { version: local.content.version, deltaCount: local.deltaCount };
    return this.#revisionResets.has(id) || this.#coldSeq === 0 || id >= this.#coldNextId
      ? undefined
      : this.#options.projection.latestRevision(id);
  }
  async #prepare(input: readonly StorageWrite[]): Promise<Prepared> {
    if (!Number.isSafeInteger(this.#seq + 1)) throw new Error("Commit sequence space is exhausted");
    const seq = (this.#seq + 1) as Seq;
    const changedDocuments = new Set(
      input.flatMap((w) =>
        w.type === "document.copy" || w.type === "document.create"
          ? [w.record.id]
          : w.type === "document.change" || w.type === "document.retire"
            ? [w.id]
            : [],
      ),
    );
    const writes: StorageWrite[] = [];
    for (const write of input) {
      if (write.type !== "document.copy") {
        writes.push(write);
        continue;
      }
      try {
        if (changedDocuments.has(write.source.id))
          throw new Error("Source is changed in the copy batch");
        const source = await this.#document(write.source.id, write.source.at),
          record = write.record;
        if (
          !source ||
          source.record.scope.kind !== "conversation" ||
          record.scope.kind !== "conversation" ||
          source.record.kind !== record.kind ||
          source.record.key !== record.key ||
          source.record.history !== record.history ||
          source.record.fork !== record.fork
        )
          throw new Error("Source does not match the copied record");
        writes.push({
          type: "document.create",
          record,
          content: { kind: "base", version: source.version, value: source.value },
        });
      } catch (error) {
        throw new StorageRejected(`Document copy ${write.record.id} was rejected`, {
          cause: error,
        });
      }
    }
    const claimed = new Map<number, IndexedRecord["kind"]>(),
      actions = new Map<DocumentId, DocumentAction>();
    let nextId = this.#nextId;
    for (const write of writes) {
      if (write.type !== "document.retire" && write.type !== "document.change") {
        const id = "value" in write ? write.value.id : write.record.id;
        const kind = "value" in write ? write.type : "document";
        const existing = await this.#get(id),
          earlier = claimed.get(id);
        if (existing && (existing.kind !== kind || (kind !== "task" && kind !== "submission")))
          throw new Error(`ID ${id} already belongs to ${existing.kind}`);
        if (
          earlier !== undefined &&
          (earlier !== kind || (kind !== "task" && kind !== "submission"))
        )
          throw new Error(`ID ${id} is written more than once`);
        claimed.set(id, kind);
        nextId = Math.max(nextId, id + 1);
      }
      if (
        write.type === "document.create" ||
        write.type === "document.change" ||
        write.type === "document.retire"
      ) {
        const id = write.type === "document.create" ? write.record.id : write.id;
        const action = actions.get(id) ?? { retire: false };
        if (write.type === "document.retire") {
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
        } else {
          if (action.content !== undefined)
            throw new Error(`Document ${id} has more than one content command`);
          action.content = write.content;
          if (write.type === "document.create") action.create = write.record;
        }
        actions.set(id, action);
      }
    }
    const records: IndexedRecord[] = [],
      revisions: DocumentRevision[] = [];
    const inputConversations = new Set<number>();
    const resetRevisions = new Set<number>(),
      retiredCurrent = new Set<number>(),
      liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      const existing = await this.#record<DocumentRecord>(id, "document");
      if (!existing && !action.create) throw new Error(`Unknown document: ${id}`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      const record: DocumentRecord = action.create
        ? { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) }
        : { ...existing!, ...(action.retire ? { retiredAt: seq } : {}) };
      if (
        record.scope.kind === "conversation" &&
        (record.kind === "pi.inbox" || record.kind === NATIVE_HUMAN_INPUT_DOCUMENT)
      )
        inputConversations.add(record.scope.conversationId);
      if (action.create || action.retire) {
        const address = documentAddress(record);
        let count = liveCounts.get(address);
        if (count === undefined) {
          const ownerId =
            record.scope.kind === "task"
              ? record.scope.taskId
              : record.scope.kind === "conversation"
                ? record.scope.conversationId
                : undefined;
          const ownerKind = record.scope.kind === "task" ? "task" : "conversation";
          const newOwner =
            ownerId !== undefined &&
            ownerId >= this.#coldNextId &&
            (claimed.get(ownerId) === ownerKind || this.#records.get(ownerId)?.kind === ownerKind);
          count = newOwner ? 0 : (await this.#findDocument(record, "current")) ? 1 : 0;
          // A previously committed local document can already occupy that
          // newly-created owner's address, even while PG is still empty.
          if (
            newOwner &&
            [...this.#records.values()].some(
              (r) =>
                r.kind === "document" && r.fields.address === address && r.retiredSeq === undefined,
            )
          )
            count = 1;
        }
        if (existing && action.retire) count--;
        if (action.create && !action.retire) count++;
        liveCounts.set(address, count);
      }
      const ordinal = writes.findIndex(
        (w) =>
          (w.type === "document.create" && w.record.id === id) ||
          (w.type === "document.change" && w.id === id),
      );
      if (action.create) records.push(indexNative("document", record, seq, ordinal));
      else if (action.retire) {
        const before = (await this.#get(id))!;
        records.push({ ...before, value: record, retiredSeq: seq });
      }
      if (action.content) {
        const previous = await this.#latestRevision(id);
        if (action.content.kind === "delta") {
          if (!previous) throw new Error(`Document ${id} delta has no base`);
          if (previous.version !== action.content.version)
            throw new Error(`Document ${id} version transition requires a base`);
        }
        if (action.content.kind === "base" && currentOnly(record)) resetRevisions.add(id);
        revisions.push({
          id,
          seq,
          ordinal,
          content: action.content,
          deltaCount: action.content.kind === "base" ? 0 : previous!.deltaCount + 1,
        });
      }
      if (action.retire && currentOnly(record)) retiredCurrent.add(id);
    }
    if ([...liveCounts.values()].some((n) => n > 1))
      throw new Error("Document address already has a current incarnation");
    for (const [ordinal, write] of writes.entries())
      if ("value" in write) records.push(indexNative(write.type, write.value, seq, ordinal));
    return {
      batch: { seq, nextId, writes },
      records,
      revisions,
      resetRevisions,
      retiredCurrent,
      inputConversations: [...inputConversations],
    };
  }
}
