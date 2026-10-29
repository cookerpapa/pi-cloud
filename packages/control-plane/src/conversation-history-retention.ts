import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  assertIdleNativeSession,
  deletePostgresPiSessionsInTransaction,
} from "@pi-cloud/pi-session-postgres";
import { retainIdleFamily } from "@pi-cloud/pi-session-postgres/durable";
import { freezeForkHistory } from "@pi-cloud/runtime-core/frozen-history";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Runs only inside the pruning transaction, after ordered writer closure. No Workspace mutation. */
export async function replacePrunedHistory(
  tx: Transaction<Database>,
  tenantId: string,
  oldId: string,
  preservedViews: readonly string[] = [],
): Promise<string> {
  const family = await tx
    .selectFrom("sessions")
    .select(["id", "pi_conversation_id", "pruned_at"])
    .where("tenant_id", "=", tenantId)
    .where("pi_session_id", "=", oldId)
    .orderBy("id")
    .forUpdate()
    .noWait()
    .execute();
  await assertIdleNativeSession(tx, tenantId, oldId);
  if (family.some((s) => s.pruned_at === null && s.pi_conversation_id === null))
    throw new ControlPlaneStoreError(
      "conflict",
      "Native child history must finish reconciliation before pruning",
    );
  const blocked =
    await sql`select 1 from runs r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
    where r.tenant_id=${tenantId}::uuid and s.pi_session_id=${oldId}
      and (r.state in ('queued','running','settling','cancel_requested') or (r.lease_id is not null and r.output_sealed_at is null))
    union all select 1 from session_upload_pins where tenant_id=${tenantId}::uuid and pi_session_id=${oldId}
    union all select 1 from turn_control_requests c join sessions s on s.tenant_id=c.tenant_id and s.id=c.session_id
      where c.tenant_id=${tenantId}::uuid and s.pi_session_id=${oldId} and c.payload->>'inputReturnPending'='true'
    limit 1`.execute(tx);
  if (blocked.rows.length)
    throw new ControlPlaneStoreError(
      "conflict",
      "Finish pending input returns, uploads and writer closure before pruning history",
    );
  const visible = family.filter((s) => s.pruned_at === null && s.pi_conversation_id !== null);
  for (const session of visible) {
    if (preservedViews.includes(session.id)) continue;
    const last = (
      await sql<{
        turn_id: string;
      }>`select turn_id from pi_history_turns where tenant_id=${tenantId}::uuid
      and session_id=${session.id}::uuid order by mailbox_position desc limit 1`.execute(tx)
    ).rows[0];
    if (last)
      await freezeForkHistory(tx, {
        tenantId,
        sourceSessionId: session.id,
        targetSessionId: session.id,
        throughTurnId: last.turn_id,
        settledOnly: true,
      });
  }
  const references = (
    await sql<{
      id: string;
      source_sequence: string;
      source_record_id: string;
      source_kind: string;
      parent_tool_call_id: string;
    }>`
    select e.id,e.source_sequence::text,e.source_record_id::text,e.source_kind,e.parent_tool_call_id from subagent_conversations e
    join sessions s on s.tenant_id=e.tenant_id and s.id=e.child_session_id
    where s.tenant_id=${tenantId}::uuid and s.pi_session_id=${oldId} and s.pruned_at is null`.execute(
      tx,
    )
  ).rows;
  const source = { tenantId, sessionId: oldId },
    target = { tenantId, sessionId: randomUUID() };
  await tx
    .insertInto("pi_sessions")
    .values({ tenant_id: tenantId, id: target.sessionId })
    .execute();
  const sourcePositions = references.map((r) => ({
    sequence: Number(r.source_sequence),
    recordId: Number(r.source_record_id),
    kind: r.source_kind,
    requestId: r.id,
  }));
  const positions = await retainIdleFamily(
    tx,
    source,
    target,
    visible.map((s) => Number(s.pi_conversation_id)),
    sourcePositions,
  );
  for (const r of references)
    await tx
      .updateTable("subagent_conversations")
      .set({
        source_sequence: String(positions.get(`${r.source_sequence}:${r.source_record_id}`)!),
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", r.id)
      .execute();
  await sql`update sessions set pi_session_id=${target.sessionId},pi_conversation_id=case when pruned_at is null then pi_conversation_id else null end,
    row_version=row_version+1 where tenant_id=${tenantId}::uuid and pi_session_id=${oldId}`.execute(
    tx,
  );
  // Upload tickets are product assets and remain usable in the same Workspace after history pruning.
  await tx
    .updateTable("session_uploads")
    .set({ pi_session_id: target.sessionId })
    .where("tenant_id", "=", tenantId)
    .where("pi_session_id", "=", oldId)
    .execute();
  await sql`delete from session_uploads u where u.tenant_id=${tenantId}::uuid and u.pi_session_id=${target.sessionId}
    and u.accepted_at is not null and u.image_id is not null and not exists(select 1 from session_image_references r
      where r.tenant_id=u.tenant_id and r.session_id=u.pi_session_id and r.image_id=u.image_id)
      and not exists(select 1 from pi_history_record_images r join pi_durable_writes w on w.tenant_id=r.tenant_id and w.retained_record_id=r.retained_record_id
        where r.tenant_id=u.tenant_id and w.session_id=u.pi_session_id and r.image_id=u.image_id)`.execute(
    tx,
  );
  await deletePostgresPiSessionsInTransaction(tx, tenantId, [oldId]);
  return target.sessionId;
}
