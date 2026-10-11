import { createHash } from "node:crypto";
import { applyImmutableBatches } from "@earendil-works/chord/delta";
import type { DocumentRecord, StorageWrite } from "@earendil-works/pi-durable";
import { NATIVE_HUMAN_INPUT_DOCUMENT } from "@pi-cloud/protocol";
import { indexNative, type DurableBatch, type IndexedRecord, type NativeRecord } from "./types.ts";

export type CurrentInputRow = {
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
export const currentInputFingerprint = (r: CurrentInputRow): string =>
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
export const isCurrentInputDocument = (
  record: Pick<DocumentRecord, "kind" | "scope" | "history">,
): boolean =>
  record.scope.kind === "conversation" &&
  record.history === "latest" &&
  (record.kind === "pi.inbox" || record.kind === NATIVE_HUMAN_INPUT_DOCUMENT);

export function currentInputIndex(row: CurrentInputRow): IndexedRecord {
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
    (write.type === "document.create" && !isCurrentInputDocument(write.record))
  )
    throw new Error("Invalid native input current-state body");
  const indexed = indexNative(row.kind, value as NativeRecord, Number(row.seq), row.ordinal);
  if (indexed.value.id !== Number(row.id)) throw new Error("Native current-state identity changed");
  Object.assign(indexed.fields, origin(row.cloud_origin));
  return indexed;
}

/** Interpret complete native commits; only the PG representation changes. */
export const currentInputIds = (batch: DurableBatch): number[] => [
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
export type CurrentInputSource = CurrentInputRow & {
  indexed_id: string;
  indexed_kind: string;
  indexed_fields: Record<string, string>;
};
export function prepareCurrentInputs(
  batch: DurableBatch,
  origins: ReadonlyMap<number, Record<string, string> | undefined>,
  previous: readonly CurrentInputSource[],
): { rows: CurrentInputRow[]; omitted: Set<number> } {
  const rows = new Map<number, CurrentInputRow>(),
    known = new Set<number>();
  for (const row of previous) {
    known.add(Number(row.indexed_id));
    const required =
      row.indexed_kind === "submission" ||
      (row.indexed_kind === "document" &&
        row.indexed_fields.currentOnly === "true" &&
        row.indexed_fields.scope !== undefined &&
        JSON.parse(row.indexed_fields.scope)[0] === "conversation" &&
        [JSON.stringify("pi.inbox"), JSON.stringify(NATIVE_HUMAN_INPUT_DOCUMENT)].includes(
          row.indexed_fields.nativeKind!,
        ));
    if (required && !row.body) throw new Error("Native input current state is missing");
    if (row.body) rows.set(Number(row.id), row);
  }
  const changed = new Set<number>(),
    omitted = new Set<number>();
  for (const [ordinal, write] of batch.writes.entries()) {
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
    if (write.type === "document.create" && isCurrentInputDocument(write.record)) {
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
    if (base.content.kind !== "base") throw new Error("Native input current base is invalid");
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
