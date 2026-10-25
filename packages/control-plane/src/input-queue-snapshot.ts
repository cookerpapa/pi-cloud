import { createHash } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  readNativeHumanInputs,
  DurablePostgresProjection,
} from "@pi-cloud/pi-session-postgres/durable";
import {
  parseInputQueueResource,
  parseUserUploads,
  INPUT_QUEUE_PAGE_SIZE,
  type InputQueueResource,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

export const EMPTY_QUEUE_REVISION = createHash("sha256").update("[]").digest("hex");
export function pgInputRevision(
  rows: readonly { turn_id: string; row_version: string; mailbox_position: string }[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.turn_id, r.row_version, r.mailbox_position])))
    .digest("hex");
}
export const queueViewVersion = (
  nativeSequence: number,
  sessionRevision: string | number,
): string => ((BigInt(nativeSequence) << 64n) + BigInt(sessionRevision)).toString();

/** Native inbox is authoritative after admission; unclaimed initial Runs still live in PG. */
export async function readInputQueue(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
  page: { afterPosition?: number; revision?: string } = {},
): Promise<InputQueueResource> {
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readInputQueue(tx, tenantId, sessionId, page));
  const afterPosition = page.afterPosition ?? 0;
  if (
    !Number.isSafeInteger(afterPosition) ||
    afterPosition < 0 ||
    (page.revision !== undefined && !/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(page.revision)) ||
    (afterPosition > 0 && page.revision === undefined)
  )
    throw new ControlPlaneStoreError("invalid_request", "Invalid queue page");
  const session = await database
    .selectFrom("sessions")
    .select([
      "row_version",
      "pi_session_id",
      "pi_conversation_id",
      sql<boolean>`exists(select 1 from turn_control_requests c where c.tenant_id=${tenantId}::uuid
      and c.session_id=${sessionId}::uuid and c.kind='cancel' and c.payload->>'inputReturnPending'='true')`.as(
        "returned",
      ),
    ])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", sessionId)
    .where("pruned_at", "is", null)
    .executeTakeFirst();
  if (!session) throw new ControlPlaneStoreError("not_found", "Session was not found");
  const latest = await database
    .selectFrom("runs")
    .select(["id", "turn_id", "state"])
    .where("tenant_id", "=", tenantId)
    .where("session_id", "=", sessionId)
    .where("pruned_at", "is", null)
    .orderBy("mailbox_position", "desc")
    .limit(1)
    .executeTakeFirst();
  const pending = await database
    .selectFrom("runs")
    .select(["id", "turn_id", "row_version", "mailbox_position"])
    .where("tenant_id", "=", tenantId)
    .where("session_id", "=", sessionId)
    .where("state", "=", "queued")
    .where("operation_kind", "=", "chat")
    .where("lease_id", "is", null)
    .where("started_at", "is", null)
    .where("pruned_at", "is", null)
    .orderBy("mailbox_position")
    .execute();
  const scope = { tenantId, sessionId: session.pi_session_id };
  const native =
    latest && session.pi_conversation_id !== null
      ? await readNativeHumanInputs(database, {
          ...scope,
          conversationId: Number(session.pi_conversation_id),
          runId: latest.id,
        })
      : {
          items: [],
          revision: EMPTY_QUEUE_REVISION,
          nativeSequence: (await new DurablePostgresProjection(database, scope).head()).seq,
        };
  const revision = `${native.revision}.${pgInputRevision(pending)}`;
  if (page.revision !== undefined && page.revision !== revision)
    throw new ControlPlaneStoreError(
      "conflict",
      "The pending queue changed; reload its first page",
    );
  const visibleNative = native.items.slice(afterPosition, afterPosition + INPUT_QUEUE_PAGE_SIZE);
  const pgStart = Math.max(0, afterPosition - native.items.length);
  const selected = pending.slice(pgStart, pgStart + INPUT_QUEUE_PAGE_SIZE - visibleNative.length);
  const bodies = selected.length
    ? await database
        .selectFrom("runs")
        .select(["id", "turn_id", "input_text", "input_uploads", "created_at"])
        .where("tenant_id", "=", tenantId)
        .where(
          "id",
          "in",
          selected.map((r) => r.id),
        )
        .orderBy("mailbox_position")
        .execute()
    : [];
  const items = [
    ...visibleNative.map(({ idempotencyKey: _key, ...item }) => ({ ...item, runId: latest!.id })),
    ...bodies.map((r, index) => ({
      inputId: r.turn_id,
      runId: r.id,
      text: r.input_text,
      uploads: parseUserUploads(r.input_uploads),
      acceptedAt: r.created_at.toISOString(),
      mailboxPosition: native.items.length + pgStart + index + 1,
      status: "queued" as const,
    })),
  ];
  return parseInputQueueResource({
    sessionId,
    revision,
    viewVersion: queueViewVersion(native.nativeSequence, session.row_version),
    afterPosition,
    hasMore: native.items.length + pending.length > afterPosition + items.length,
    activeTurnId: latest?.state === "running" ? latest.turn_id : null,
    hasReturnedInputs: session.returned,
    items,
  });
}
