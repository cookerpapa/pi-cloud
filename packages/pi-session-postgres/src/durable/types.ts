import type { JsonValue } from "@earendil-works/chord";
import type { ImagePacked } from "@pi-cloud/protocol";
import type {
  ConversationRecord,
  DocumentContent,
  DocumentRecord,
  EntryRecord,
  Seq,
  StorageWrite,
  SubmissionRecord,
  TaskRecord,
} from "@earendil-works/pi-durable";

export type DurableScope = Readonly<{ tenantId: string; sessionId: string }>;
export type DurableBatch = Readonly<{ seq: Seq; nextId: number; writes: readonly StorageWrite[] }>;
export type StoredDurableBatch = ImagePacked<DurableBatch>;
export type DurableRecordKind = "conversation" | "entry" | "task" | "submission" | "document";
export type NativeRecord =
  | ConversationRecord
  | EntryRecord
  | SubmissionRecord
  | TaskRecord<JsonValue, JsonValue, JsonValue>
  | DocumentRecord;
export type IndexedRecord = {
  kind: DurableRecordKind;
  value: NativeRecord;
  seq: number;
  ordinal: number;
  fields: Record<string, string>;
  createdSeq?: number;
  retiredSeq?: number;
};
export type RecordQuery = {
  kind: DurableRecordKind;
  fields?: Record<string, string>;
  minId?: number;
  maxId?: number;
  head?: boolean;
  at?: number | "current";
  descending?: boolean;
};
export type DocumentRevision = {
  id: number;
  seq: number;
  ordinal: number;
  content: DocumentContent;
  deltaCount: number;
  checkpoint?: Record<string, JsonValue>;
};
export const cloneNative = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const documentScope = (scope: DocumentRecord["scope"]): string =>
  JSON.stringify(
    scope.kind === "session"
      ? ["session"]
      : scope.kind === "conversation"
        ? ["conversation", scope.conversationId]
        : ["task", scope.taskId],
  );
export const documentAddress = (record: {
  kind: string;
  scope: DocumentRecord["scope"];
  key?: string;
}): string =>
  JSON.stringify([
    record.kind,
    documentScope(record.scope),
    record.key === undefined ? [] : [record.key],
  ]);
export const currentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";
export function indexNative(
  kind: DurableRecordKind,
  value: NativeRecord,
  seq: number,
  ordinal: number,
): IndexedRecord {
  const fields: Record<string, string> = {};
  if (kind === "conversation") {
    const record = value as ConversationRecord;
    if (record.owner) {
      fields.ownerConversation = String(record.owner.conversationId);
      fields.ownerTask = String(record.owner.taskId);
    }
  } else if (kind === "document") {
    const record = value as DocumentRecord;
    fields.scope = documentScope(record.scope);
    fields.address = documentAddress(record);
    fields.nativeKind = JSON.stringify(record.kind);
    if (record.key !== undefined) fields.key = JSON.stringify(record.key);
    fields.currentOnly = String(currentOnly(record));
    return {
      kind,
      value,
      seq,
      ordinal,
      fields,
      createdSeq: record.createdAt,
      ...(record.retiredAt === undefined ? {} : { retiredSeq: record.retiredAt }),
    };
  } else {
    const record = value as
      EntryRecord | SubmissionRecord | TaskRecord<JsonValue, JsonValue, JsonValue>;
    fields.conversation = String(record.conversationId);
    if (kind === "entry") {
      const entry = record as EntryRecord;
      fields.nativeKind = JSON.stringify(entry.kind);
      if (entry.byTaskId !== undefined) fields.task = String(entry.byTaskId);
      if (entry.model?.[0]) fields.role = entry.model[0].role;
      const visible = entry.model?.find(
        (message) => message.role === "user" || message.role === "assistant",
      );
      fields.navigation =
        visible?.role === "user"
          ? "user"
          : visible?.role === "assistant" &&
              typeof visible.stopReason === "string" &&
              !["toolUse", "error", "aborted", "pending", "deferred"].includes(visible.stopReason)
            ? "assistant"
            : "none";
      if (entry.head !== undefined) fields.head = String(entry.head);
    } else if (kind === "submission") {
      const submission = record as SubmissionRecord;
      fields.status = submission.status;
      if (submission.status === "unanswered") fields.reason = submission.reason;
      if (submission.entry !== undefined) fields.entry = String(submission.entry);
      if (submission.requestId !== undefined) fields.request = JSON.stringify(submission.requestId);
    } else {
      const task = record as TaskRecord<JsonValue, JsonValue, JsonValue>;
      fields.nativeKind = JSON.stringify(task.kind);
      fields.status = task.state.status;
      fields.background = String(task.background);
      fields.abortRequested = String(task.abortRequested);
      if (task.state.status === "terminal") fields.outcome = task.state.outcome.status;
    }
  }
  return { kind, value, seq, ordinal, fields };
}
export function matchesRecord(record: IndexedRecord, query: RecordQuery): boolean {
  return (
    record.kind === query.kind &&
    (query.minId === undefined || record.value.id >= query.minId) &&
    (query.maxId === undefined || record.value.id <= query.maxId) &&
    (!query.head || record.fields.head !== undefined) &&
    Object.entries(query.fields ?? {}).every(([key, value]) => record.fields[key] === value) &&
    (query.at === undefined ||
      (query.at === "current"
        ? record.retiredSeq === undefined
        : record.createdSeq! <= query.at &&
          (record.retiredSeq === undefined || record.retiredSeq > query.at)))
  );
}
