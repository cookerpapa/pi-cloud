import { captureNativePresentation } from "../../../runtime-core/src/frozen-history.ts";
import type { Database } from "@pi-cloud/database";
import {
  DurablePostgresProjection,
  type DurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import type { Kysely, Transaction } from "kysely";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Seed native records at an explicit fixture boundary, not through a retired
 * SDK or a production compatibility path. IDs share the native numeric space. */
export async function appendNativeFixture(
  db: Kysely<Database>,
  scope: {
    tenantId: string;
    sessionId: string;
    conversationId?: number;
    turnId?: string;
    runId?: string;
  },
  entries: readonly Record<string, unknown>[],
) {
  const projection = new DurablePostgresProjection(db, scope, undefined, "references"),
    head = await projection.head();
  const conversationId = scope.conversationId ?? 1;
  const writes: Record<string, unknown>[] = [];
  if (!(await projection.get(conversationId)))
    writes.push({ type: "conversation", value: { id: conversationId } });
  let nextId = Math.max(head.nextId, conversationId + 1);
  const native = entries.map((entry) => {
    const id = entry.id === undefined ? nextId++ : Number(entry.id);
    if (!Number.isSafeInteger(id) || id < 2)
      throw new Error("Fixture entry ID must be a positive native ID");
    nextId = Math.max(nextId, id + 1);
    const value = { ...entry, id, conversationId } as unknown as EntryRecord;
    writes.push({ type: "entry", value });
    return value;
  });
  let runId = scope.runId;
  if (scope.turnId && !runId)
    runId = (
      await db
        .selectFrom("runs")
        .select("id")
        .where("turn_id", "=", scope.turnId)
        .where("tenant_id", "=", scope.tenantId)
        .executeTakeFirstOrThrow()
    ).id;
  const batch = { seq: head.seq + 1, nextId, writes } as unknown as DurableBatch;
  const origins =
    scope.turnId && runId
      ? native.map((entry) => ({
          recordId: entry.id,
          sessionId: scope.sessionId,
          turnId: scope.turnId!,
          runId,
        }))
      : [];
  const apply = async (tx: Transaction<Database>) => {
    await projection.applyIn(tx, batch, origins);
    await captureNativePresentation(tx, scope, batch.seq);
  };
  if (db.isTransaction) await apply(db as Transaction<Database>);
  else await db.transaction().execute(apply);
  return native;
}
