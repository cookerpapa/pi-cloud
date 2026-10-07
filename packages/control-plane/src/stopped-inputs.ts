import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  INPUT_QUEUE_PAGE_SIZE,
  parseReturnedInputsResource,
  parseUserUploads,
  type ReturnedInputsResource,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** The caller owns the Session lock and has persisted the Stop request. Freeze
 * the exact queue cut; held Steers need canonical consumption reconciliation. */
export async function withdrawStoppedInputs(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await sql`
    with withdrawn as (
      update runs set input_return_request_id=${requestId}::uuid, ready_at=null,
        state=case when queued_steer_id is null then 'cancelled' else state end,
        stop_reason=case when queued_steer_id is null then 'queued_input_withdrawn' else stop_reason end,
        settled_at=case when queued_steer_id is null then clock_timestamp() else settled_at end,
        row_version=row_version+1,updated_at=clock_timestamp()
      where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid
        and state='queued' and lease_id is null and started_at is null and input_return_request_id is null
      returning id,turn_id,state
    ), turns_updated as (
      update turns t set state='cancelled', stop_reason='queued_input_withdrawn', settled_at=clock_timestamp()
      from withdrawn w where w.state='cancelled' and t.id=w.turn_id and t.tenant_id=${tenantId}::uuid
    ), transitions as (
      insert into run_transitions(id,tenant_id,run_id,from_state,to_state,reason,occurred_at)
      select gen_random_uuid(),${tenantId}::uuid,id,'queued','cancelled','queued_input_withdrawn',clock_timestamp()
      from withdrawn where state='cancelled'
    ) update turn_control_requests set payload=payload || '{"inputReturnPending":true}'::jsonb
      where id=${requestId}::uuid and exists(select 1 from withdrawn)
  `.execute(tx);
}

/** Each Stop has immutable pages. Acknowledging a recovered batch never hides
 * later pages from another browser already reading that same Stop. */
export async function readReturnedInputs(
  database: Kysely<Database>,
  tenantId: string,
  sessionId: string,
  page: { requestId?: string; afterPosition?: number } = {},
): Promise<ReturnedInputsResource> {
  const afterPosition = page.afterPosition ?? 0;
  if (
    !Number.isSafeInteger(afterPosition) ||
    afterPosition < 0 ||
    (afterPosition > 0 && !page.requestId)
  )
    throw new ControlPlaneStoreError("invalid_request", "Invalid returned input page");
  const { rows } = await sql<{
    requestId: string | null;
    pending: boolean;
    items: {
      turnId: string;
      idempotencyKey: string;
      text: string;
      uploads: unknown;
      mailboxPosition: number;
    }[];
  }>`select batch.id as "requestId",
    exists(select 1 from runs r where r.tenant_id=s.tenant_id and r.session_id=s.id
      and r.input_return_request_id=batch.id and r.state='queued') as pending,
    coalesce((select json_agg(item) from (
      select r.turn_id as "turnId",r.idempotency_key as "idempotencyKey",
        t.input_text as text,t.input_uploads as uploads,
        r.mailbox_position as "mailboxPosition"
      from runs r join turns t on t.id=r.turn_id and t.tenant_id=r.tenant_id
      where r.tenant_id=s.tenant_id and r.session_id=s.id
        and r.input_return_request_id=batch.id and r.state='cancelled'
        and r.stop_reason='queued_input_withdrawn' and r.mailbox_position>${afterPosition}
      order by r.mailbox_position limit ${INPUT_QUEUE_PAGE_SIZE + 1}
    ) item),'[]'::json) as items
    from sessions s left join lateral (
      select c.id from turn_control_requests c where c.tenant_id=s.tenant_id and c.session_id=s.id
        and c.kind='cancel'
        ${page.requestId ? sql`and c.id=${page.requestId}::uuid` : sql`and c.payload->>'inputReturnPending'='true'`}
      order by c.created_at,c.id limit 1
    ) batch on true
    where s.tenant_id=${tenantId}::uuid and s.id=${sessionId}::uuid and s.pruned_at is null`.execute(
    database,
  );
  const row = rows[0];
  if (!row || (page.requestId && !row.requestId))
    throw new ControlPlaneStoreError("not_found", "Session or input return was not found");
  return parseReturnedInputsResource({
    sessionId,
    requestId: row.requestId,
    afterPosition,
    pending: row.pending,
    hasMore: !row.pending && row.items.length > INPUT_QUEUE_PAGE_SIZE,
    items: row.pending
      ? []
      : row.items.slice(0, INPUT_QUEUE_PAGE_SIZE).map((item) => ({
          ...item,
          mailboxPosition: Number(item.mailboxPosition),
          uploads: parseUserUploads(item.uploads),
        })),
  });
}
