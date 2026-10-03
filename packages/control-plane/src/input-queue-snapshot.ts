import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import {
  parseInputQueueResource,
  parseUserUploads,
  INPUT_QUEUE_PAGE_SIZE,
  type InputQueueResource,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

function number(value: string | number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid queue position/version");
  return n;
}

export async function readInputQueue(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
  page: { afterPosition?: number; viewVersion?: string } = {},
): Promise<InputQueueResource> {
  const afterPosition = page.afterPosition ?? 0;
  if (
    !Number.isSafeInteger(afterPosition) ||
    afterPosition < 0 ||
    (page.viewVersion !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(page.viewVersion)) ||
    (afterPosition > 0 && page.viewVersion === undefined)
  )
    throw new ControlPlaneStoreError("invalid_request", "Invalid queue page");
  // One statement supplies one MVCC snapshot without a polling transaction
  // or separate Session / pending / active reads.
  const session = await database
    .selectFrom("sessions as s")
    .select((eb) => [
      "s.row_version",
      eb
        .selectFrom("outbox")
        .select(sql<string>`payload->>'version'`.as("version"))
        .whereRef("tenant_id", "=", "s.tenant_id")
        .whereRef("aggregate_id", "=", "s.id")
        .where("topic", "=", sql.lit("session.control.changed.v1"))
        .where(sql<string>`payload->>'entity'`, "=", sql.lit("input_queue"))
        .orderBy(sql`(payload->>'version')::bigint`, "desc")
        .limit(1)
        .as("viewVersion"),
      eb
        .selectFrom("runs")
        .select("turn_id")
        .whereRef("tenant_id", "=", "s.tenant_id")
        .whereRef("session_id", "=", "s.id")
        .where("state", "=", "running")
        .limit(1)
        .as("activeTurnId"),
      jsonArrayFrom(
        eb
          .selectFrom("runs as r")
          .innerJoin("turns as t", "t.id", "r.turn_id")
          .select([
            "r.id",
            "r.turn_id",
            "r.mailbox_position",
            "r.created_at",
            "r.queued_steer_id",
            "t.input_text",
            "t.input_uploads",
          ])
          .whereRef("r.tenant_id", "=", "s.tenant_id")
          .whereRef("r.session_id", "=", "s.id")
          .where(sql<boolean>`r.state='queued'`)
          .where("r.lease_id", "is", null)
          .where("t.state", "=", "queued")
          .where("r.mailbox_position", ">", String(afterPosition))
          .orderBy("r.mailbox_position", "asc")
          .limit(INPUT_QUEUE_PAGE_SIZE + 1),
      ).as("items"),
    ])
    .where("s.tenant_id", "=", tenantId)
    .where("s.id", "=", sessionId)
    .where("s.pruned_at", "is", null)
    .executeTakeFirst();
  if (!session) throw new ControlPlaneStoreError("not_found", "Session was not found");
  const viewVersion = session.viewVersion ?? "0";
  if (page.viewVersion !== undefined && page.viewVersion !== viewVersion)
    throw new ControlPlaneStoreError("conflict", "The queue changed; reload its first page");
  return parseInputQueueResource({
    sessionId,
    revision: number(session.row_version),
    viewVersion,
    afterPosition,
    hasMore: session.items.length > INPUT_QUEUE_PAGE_SIZE,
    activeTurnId: session.activeTurnId ?? null,
    items: session.items.slice(0, INPUT_QUEUE_PAGE_SIZE).map((item) => ({
      turnId: item.turn_id,
      runId: item.id,
      text: item.input_text,
      ...(item.input_uploads.length ? { uploads: parseUserUploads(item.input_uploads) } : {}),
      mailboxPosition: number(item.mailbox_position),
      acceptedAt: new Date(item.created_at).toISOString(),
      status: item.queued_steer_id === null ? "queued" : "steering",
    })),
  });
}
