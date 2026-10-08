import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  INPUT_QUEUE_PAGE_SIZE,
  parseReturnedInputsResource,
  parseUserUploads,
  type ReturnedInputsResource,
} from "@pi-cloud/protocol";
import {
  readNativeHumanInputs,
  readHumanInputOutcomes,
} from "@pi-cloud/pi-session-postgres/durable";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Stop's native abort determines which already-admitted human inputs remain unused. */
export async function requestInputReturn(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await tx
    .updateTable("turn_control_requests")
    .set({ payload: sql`payload || '{"inputReturnPending":true}'::jsonb` })
    .where("tenant_id", "=", tenantId)
    .where("session_id", "=", sessionId)
    .where("id", "=", requestId)
    .where("kind", "=", "cancel")
    .execute();
}

export async function readReturnedInputs(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
  page: { requestId?: string; afterPosition?: number } = {},
): Promise<ReturnedInputsResource> {
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readReturnedInputs(tx, tenantId, sessionId, page));
  const afterPosition = page.afterPosition ?? 0;
  if (
    !Number.isSafeInteger(afterPosition) ||
    afterPosition < 0 ||
    (afterPosition > 0 && !page.requestId)
  )
    throw new ControlPlaneStoreError("invalid_request", "Invalid returned input page");
  const session = await database
    .selectFrom("sessions")
    .select(["pi_session_id", "pi_conversation_id"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", sessionId)
    .where("pruned_at", "is", null)
    .executeTakeFirst();
  if (!session) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
  const stop = await database
    .selectFrom("turn_control_requests as c")
    .innerJoin("runs as r", "r.id", "c.target_run_id")
    .select(["c.id", "r.id as runId", "r.state", "r.lease_id", "r.output_sealed_at"])
    .where("c.tenant_id", "=", tenantId)
    .where("c.session_id", "=", sessionId)
    .where("c.kind", "=", "cancel")
    .$if(page.requestId !== undefined, (q) => q.where("c.id", "=", page.requestId!))
    .$if(page.requestId === undefined, (q) =>
      q.where(sql<string>`c.payload->>'inputReturnPending'`, "=", "true"),
    )
    .orderBy("c.created_at")
    .orderBy("c.id")
    .limit(1)
    .executeTakeFirst();
  if (page.requestId && !stop)
    throw new ControlPlaneStoreError("not_found", "Stopped input batch was not found");
  const pending =
    stop !== undefined &&
    (!["completed", "failed", "cancelled", "timed_out"].includes(stop.state) ||
      (stop.lease_id !== null && stop.output_sealed_at === null));
  let items: Array<{
    inputId: string;
    idempotencyKey: string;
    text: string;
    uploads: ReturnType<typeof parseUserUploads>;
    mailboxPosition: number;
  }> = [];
  if (stop && !pending && session.pi_conversation_id !== null) {
    const scope = {
      tenantId,
      sessionId: session.pi_session_id,
      conversationId: Number(session.pi_conversation_id),
    };
    const native = await readNativeHumanInputs(database, { ...scope, runId: stop.runId });
    const outcomes = await readHumanInputOutcomes(database, scope, native.state);
    items = native.state.order
      .flatMap((id, index) => {
        const input = native.state.inputs[id],
          outcome = outcomes.get(id);
        if (
          !input ||
          input.cancelled ||
          !outcome ||
          outcome.entry !== undefined ||
          !(
            outcome.status === "queued" ||
            (outcome.status === "unanswered" && outcome.reason === "aborted")
          )
        )
          return [];
        return [
          {
            inputId: id,
            idempotencyKey: input.idempotencyKey,
            text: input.text,
            uploads: parseUserUploads(input.uploads),
            mailboxPosition: index + 1,
          },
        ];
      })
      .filter((item) => item.mailboxPosition > afterPosition);
  }
  return parseReturnedInputsResource({
    sessionId,
    requestId: stop?.id ?? null,
    afterPosition,
    pending,
    hasMore: !pending && items.length > INPUT_QUEUE_PAGE_SIZE,
    items: items.slice(0, INPUT_QUEUE_PAGE_SIZE),
  });
}
