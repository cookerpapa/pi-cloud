import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { SESSION_ACTIVITY_FRESH_MS, type PhysicalResourceUse } from "@pi-cloud/protocol";

/** Deadline is resource policy, not an observation of physical existence. */
export async function recordResourceUse(
  database: Kysely<Database>,
  domain: string,
  uses: readonly PhysicalResourceUse[],
): Promise<number> {
  if (!uses.length) return 0;
  const payload = JSON.stringify(
    uses.map((use) => ({ ...use, observedAt: new Date(use.observedAt).toISOString() })),
  );
  const result = await sql<{ changed: string }>`with input as materialized (
    select kind,"tenantId"::uuid as tenant,id::uuid as id,max("observedAt") as at
    from jsonb_to_recordset(${payload}::jsonb) as t(kind text,"tenantId" text,id text,"observedAt" timestamptz)
    where "observedAt" between clock_timestamp()-${SESSION_ACTIVITY_FRESH_MS}*interval '1 millisecond' and clock_timestamp()+interval '5 seconds'
    group by kind,"tenantId"::uuid,id::uuid
  ), workspace_use as (
    update workspace_runtimes r set idle_expires_at=greatest(r.idle_expires_at,i.at+(r.creation_spec->>'retentionWindowMs')::bigint*interval '1 millisecond')
    from input i where i.kind='workspace' and r.workspace_runtime_id=i.id and r.tenant_id=i.tenant
      and r.sandbox_domain_id=${domain} and r.state='allocated' and not r.allocation_closed
      and r.idle_expires_at<i.at+(r.creation_spec->>'retentionWindowMs')::bigint*interval '1 millisecond'
    returning 1
  ), terminal_use as (
    update workspace_terminal_sessions r set idle_expires_at=greatest(r.idle_expires_at,i.at+(r.creation_spec->>'retentionWindowMs')::bigint*interval '1 millisecond')
    from input i where i.kind='terminal' and r.terminal_id=i.id and r.tenant_id=i.tenant
      and r.sandbox_domain_id=${domain} and r.state='active' and not r.allocation_closed
      and r.idle_expires_at<i.at+(r.creation_spec->>'retentionWindowMs')::bigint*interval '1 millisecond'
    returning 1
  ) select ((select count(*) from workspace_use)+(select count(*) from terminal_use))::text as changed`.execute(
    database,
  );
  return Number(result.rows[0]!.changed);
}

/** Called inside the existing resource owner's transaction. Workspace admission
 * locks first, then allocation rows, matching reserve/reuse lock order. */
export async function claimIdleExpiry(
  tx: Transaction<Database>,
  domain: string,
  owner: string,
  kind: "workspace" | "terminal",
  limit: number,
) {
  const table = kind === "workspace" ? "workspace_runtimes" : "workspace_terminal_sessions";
  const key = kind === "workspace" ? "workspace_runtime_id" : "terminal_id";
  const state = kind === "workspace" ? "allocated" : "active";
  const due = () =>
    tx
      .selectFrom(table)
      .selectAll()
      .where("sandbox_domain_id", "=", domain)
      .where("owner_instance_id", "=", owner)
      .where("state", "=", sql.lit(state))
      .where("allocation_closed", "=", sql.lit(false))
      .where("idle_expires_at", "<=", sql<Date>`statement_timestamp()`);
  // Lock skipping happens before LIMIT, so a busy old Workspace cannot starve
  // later due allocations. A fresh statement below rechecks renewals.
  const { rows: locked } = await sql<{ id: string }>`
    select w.id from ${sql.table(table)} r join workspaces w on w.id=r.workspace_id
    where r.sandbox_domain_id=${domain} and r.owner_instance_id=${owner}::uuid
      and r.state=${sql.lit(state)} and not r.allocation_closed and r.idle_expires_at<=statement_timestamp()
    order by r.idle_expires_at,r.${sql.ref(key)} limit ${limit}
    for update of w skip locked`.execute(tx);
  if (!locked.length) return [];
  const rows = await due()
    .where(
      "workspace_id",
      "in",
      locked.map((r) => r.id),
    )
    .orderBy("idle_expires_at")
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
  const ids = rows.map((r) => (r as unknown as Record<string, string>)[key]!);
  if (!ids.length) return [];
  await sql`update ${sql.table(table)} set state='cleaning',allocation_closed=true,
    failure_code='runtime_idle_expired',updated_at=clock_timestamp()
    where ${sql.ref(key)}=any(${ids}::uuid[])`.execute(tx);
  // The existing allocation-close trigger fences all related Tool bindings.
  return rows;
}
