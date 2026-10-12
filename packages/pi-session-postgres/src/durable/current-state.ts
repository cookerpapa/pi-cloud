import { createHash } from "node:crypto";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import type { DocumentRecord, StorageWrite } from "@earendil-works/pi-durable";
import { NATIVE_HUMAN_INPUT_DOCUMENT } from "@pi-cloud/protocol";
import { indexNative, type DurableBatch, type IndexedRecord, type NativeRecord } from "./types.ts";

export type CurrentStateRow = {
  id: string;
  kind: "document" | "submission";
  seq: string;
  ordinal: number;
  body: string;
  delta_count: number;
  created_seq: string | null;
  retired_seq: string | null;
  cloud_origin: Record<string, string> | null;
};
export type HistoryWriteRow = {
  ordinal: number;
  record_kind: string;
  record_id: string;
  body: string;
  phase: string | null;
  cloud_origin: Record<string, string> | null;
};
const origin = (value: Record<string, string> | null | undefined) =>
  value
    ? Object.fromEntries(
        ["cloudSession", "run", "turn"]
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, value[key]!]),
      )
    : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const historyFingerprint = (rows: readonly HistoryWriteRow[]): string =>
  digest(
    rows.map((r) => [
      r.ordinal,
      r.record_kind,
      String(r.record_id),
      r.body,
      r.phase,
      origin(r.cloud_origin),
    ]),
  );
export const currentStateFingerprint = (r: CurrentStateRow): string =>
  digest([
    String(r.id),
    r.kind,
    String(r.seq),
    r.ordinal,
    r.body,
    r.delta_count,
    r.created_seq === null ? null : String(r.created_seq),
    r.retired_seq === null ? null : String(r.retired_seq),
    origin(r.cloud_origin),
  ]);
export const isCurrentStateDocument = (
  record: Pick<DocumentRecord, "kind" | "scope" | "history">,
): boolean =>
  record.scope.kind === "conversation" &&
  record.history === "latest" &&
  (record.kind === "pi.inbox" ||
    record.kind === NATIVE_HUMAN_INPUT_DOCUMENT ||
    record.kind === "pi.live");

export const isLiveDocument = (
  record: Pick<DocumentRecord, "kind" | "scope" | "history">,
): boolean => record.kind === "pi.live" && isCurrentStateDocument(record);

/** Matches the pinned native LiveDoc checkpoint predicate. */
export function isSettledLiveValue(value: Record<string, unknown>): boolean {
  return (
    value.generation === undefined &&
    !(Array.isArray(value.tools) && value.tools.some((slot) => slot?.status === "running"))
  );
}

export function isLiveRow(row: CurrentStateRow): boolean {
  if (row.kind !== "document") return false;
  const write = JSON.parse(row.body) as StorageWrite;
  return write.type === "document.create" && isLiveDocument(write.record);
}

export function isPendingLiveRow(row: CurrentStateRow): boolean {
  if (row.retired_seq !== null || !isLiveRow(row)) return false;
  return !isSettledLiveValue(JSON.parse(row.body).content.value);
}

export function currentStateIndex(row: CurrentStateRow): IndexedRecord {
  const write = JSON.parse(row.body) as StorageWrite;
  const value =
    write.type === "document.create"
      ? {
          ...write.record,
          createdAt: Number(row.created_seq),
          ...(row.retired_seq === null ? {} : { retiredAt: Number(row.retired_seq) }),
        }
      : write.type === "submission"
        ? write.value
        : undefined;
  if (
    !value ||
    (row.kind === "document") !== (write.type === "document.create") ||
    (write.type === "document.create" && !isCurrentStateDocument(write.record))
  )
    throw new Error("Invalid native current-state body");
  const indexed = indexNative(row.kind, value as NativeRecord, Number(row.seq), row.ordinal);
  if (indexed.value.id !== Number(row.id)) throw new Error("Native current-state identity changed");
  Object.assign(indexed.fields, origin(row.cloud_origin));
  return indexed;
}

/** Interpret complete native commits; only the PG representation changes. */
export const currentStateIds = (batch: DurableBatch): number[] => [
  ...new Set(
    batch.writes.flatMap<number>((w) =>
      w.type === "submission"
        ? [w.value.id]
        : w.type === "document.change" || w.type === "document.retire"
          ? [w.id]
          : w.type === "document.create"
            ? [w.record.id]
            : [],
    ),
  ),
];
export type CurrentStateSource = CurrentStateRow & {
  indexed_id: string;
  indexed_kind: string;
  indexed_fields: Record<string, string>;
  replay_topic: string | null;
  replay_partition: number | null;
  replay_offset: string | null;
  replay_seq: string | null;
};
export function prepareCurrentStates(
  batch: DurableBatch,
  origins: ReadonlyMap<number, Record<string, string> | undefined>,
  previous: readonly CurrentStateSource[],
  include: (write: StorageWrite, ordinal: number) => boolean = () => true,
): { rows: CurrentStateRow[]; omitted: Set<number> } {
  const rows = new Map<number, CurrentStateRow>(),
    known = new Set<number>();
  for (const row of previous) {
    known.add(Number(row.indexed_id));
    const required =
      row.indexed_kind === "submission" ||
      (row.indexed_kind === "document" &&
        row.indexed_fields.currentOnly === "true" &&
        row.indexed_fields.scope !== undefined &&
        JSON.parse(row.indexed_fields.scope)[0] === "conversation" &&
        [
          JSON.stringify("pi.inbox"),
          JSON.stringify(NATIVE_HUMAN_INPUT_DOCUMENT),
          JSON.stringify("pi.live"),
        ].includes(row.indexed_fields.nativeKind!));
    if (required && !row.body) throw new Error("Native current state is missing");
    if (row.body) rows.set(Number(row.id), row);
  }
  const changed = new Set<number>(),
    omitted = new Set<number>();
  for (const [ordinal, write] of batch.writes.entries()) {
    if (!include(write, ordinal)) continue;
    if (write.type === "submission") {
      const id = write.value.id;
      rows.set(id, {
        id: String(id),
        kind: "submission",
        seq: String(batch.seq),
        ordinal,
        body: JSON.stringify(write),
        delta_count: 0,
        created_seq: null,
        retired_seq: null,
        cloud_origin: origin(origins.get(id)),
      });
      changed.add(id);
      omitted.add(ordinal);
      continue;
    }
    if (write.type === "document.create" && isCurrentStateDocument(write.record)) {
      if (known.has(write.record.id) || changed.has(write.record.id))
        throw new Error("Native record ID ownership changed");
      if (write.content.kind !== "base") throw new Error("Native document needs an initial base");
      rows.set(write.record.id, {
        id: String(write.record.id),
        kind: "document",
        seq: String(batch.seq),
        ordinal,
        body: JSON.stringify(write),
        delta_count: 0,
        created_seq: String(batch.seq),
        retired_seq: null,
        cloud_origin: origin(origins.get(write.record.id)),
      });
      changed.add(write.record.id);
      omitted.add(ordinal);
      continue;
    }
    if (write.type !== "document.change" && write.type !== "document.retire") continue;
    const previous = rows.get(write.id);
    if (!previous) continue;
    if (previous.kind !== "document" || previous.retired_seq !== null)
      throw new Error("Native current document is unavailable");
    const base = JSON.parse(previous.body) as Extract<StorageWrite, { type: "document.create" }>;
    if (base.content.kind !== "base") throw new Error("Native current base is invalid");
    let deltaCount = previous.delta_count;
    let nextContent = base.content;
    if (write.type === "document.change") {
      const content = write.content;
      if (content.kind === "delta" && content.version !== base.content.version)
        throw new Error("Native document version mismatch");
      nextContent =
        content.kind === "base"
          ? content
          : {
              kind: "base",
              version: content.version,
              value: applyImmutableBatches(base.content.value, [content.ops]),
            };
      deltaCount = content.kind === "base" ? 0 : deltaCount + 1;
    } else {
      // Retired latest-only content is no longer addressable. Keep its identity.
      nextContent = { ...base.content, value: {} };
    }
    rows.set(write.id, {
      ...previous,
      seq: String(batch.seq),
      ordinal,
      body: JSON.stringify({ ...base, content: nextContent }),
      delta_count: deltaCount,
      retired_seq: write.type === "document.retire" ? String(batch.seq) : null,
    });
    changed.add(write.id);
    omitted.add(ordinal);
  }
  return { rows: [...changed].map((id) => rows.get(id)!), omitted };
}
