import { applyImmutableBatches } from "@earendil-works/chord/delta";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  DocumentId,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
} from "@earendil-works/pi-durable";
import type {
  DurableSessionHandle,
  NativeDocumentChange,
} from "@pi-cloud/pi-session-postgres/durable";
import {
  resolveDurableDisplay,
  type DurableSessionCommit,
  type PiCloudEvent,
} from "@pi-cloud/protocol";

/** Test counterpart of the physical-Session publication line, using real Pi writes. */
export function nativeTestDisplay(onText: (event: PiCloudEvent) => void) {
  let prepare: Parameters<DurableSessionHandle["prepareDisplay"]>[0] | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    prepareDisplay(value: NonNullable<typeof prepare>) {
      prepare = value;
    },
    serializePublication<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work);
      tail = next.catch(() => undefined);
      return next;
    },
    async compile(storage: Storage, writes: readonly StorageWrite[], seq: number) {
      const documents: NativeDocumentChange[] = [];
      for (const write of writes) {
        if (write.type !== "document.change" && write.type !== "document.create") continue;
        const before =
          write.type === "document.change"
            ? await storage.document(write.id as DocumentId, "current", BACKGROUND_CONTEXT)
            : undefined;
        const record =
          write.type === "document.create"
            ? { ...write.record, createdAt: seq as Seq }
            : before!.record;
        if (record.kind !== "pi.live") continue;
        const after: StoredDocument = {
          record,
          version: write.content.version,
          deltasSinceBase: 0,
          value:
            write.content.kind === "base"
              ? write.content.value
              : applyImmutableBatches(before!.value, [write.content.ops]),
        };
        documents.push({ record, before, after });
      }
      const commit = { seq, nextId: 10000, writes } as unknown as DurableSessionCommit;
      const prepared = prepare?.(commit, documents);
      return () => {
        prepared?.confirmed();
        for (const text of prepared?.events ?? [])
          onText(
            resolveDurableDisplay(
              commit,
              text,
              (id) => documents.find((d) => d.record.id === id)?.after?.value,
            ),
          );
      };
    },
  };
}
