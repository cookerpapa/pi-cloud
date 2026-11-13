import assert from "node:assert/strict";
import { sql } from "kysely";
import { maintenanceMachineRetired } from "./compute-retirement.mjs";

async function assertDrained(database) {
  const { rows } = await sql`select
    (select count(*) from runs where state not in ('completed','failed','cancelled','timed_out')
      or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))::int as runs,
    (select count(*) from session_leases where released_at is null)::int as writers,
    (select count(*) from sandbox_tool_bindings)::int as bindings,
    (select count(*) from workspace_terminal_sessions where state<>'released')::int as terminals,
    (select count(*) from workspaces where deleted_at is not null and storage_purged_at is null)::int as pending_storage_deletions,
    (select count(*) from development_environments where agent_activation_id is not null or terminal_active)::int as machine_holders,
    (select count(*) from sandbox_control_instances where state='ready' and lease_expires_at>clock_timestamp())::int as owners,
    (select count(*) from supervisor_connections where state='active' and expires_at>clock_timestamp())::int as workers
  `.execute(database);
  assert(
    rows.length === 1 && Object.values(rows[0]).every((n) => n === 0),
    "Drain Runs/seals, Session writers, bindings, terminals and live owner/Worker leases first",
  );
}

function target(row, kind) {
  assert(
    row.workspace_present && row.workspace_deleted_at === null,
    "Retained Workspace ownership is unavailable",
  );
  return {
    kind,
    id: kind === "machine" ? row.id : row.workspace_runtime_id,
    allocationId: kind === "machine" ? row.allocation_id : row.workspace_runtime_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    domainId: row.sandbox_domain_id,
    ownerId: row.owner_instance_id,
    ownerBaseUrl: row.owner_base_url,
    creationSpec: row.creation_spec,
    runtimeId: row.runtime_id,
    runtimeName: row.runtime_name,
    capsule: row.runtime_capsule,
    providerReceipt: row.provider_receipt,
    providerCreateStartedAt: row.provider_create_started_at,
    state: row.state,
    allocationClosed: row.allocation_closed,
    ...(kind === "machine"
      ? {
          desiredState: row.desired_state,
          intentRevision: String(row.intent_revision),
          generation: String(row.generation),
          allocationAbsent: row.allocation_absent,
          environmentVersionId: row.environment_version_id,
          agentActivationId: row.agent_activation_id,
          terminalActive: row.terminal_active,
        }
      : {}),
  };
}

function tableFor(value) {
  assert(["machine", "elastic"].includes(value.kind), "Invalid retirement table");
  return value.kind === "machine" ? "development_environments" : "workspace_runtimes";
}

function matching(query, value) {
  const fields = {
    [value.kind === "machine" ? "id" : "workspace_runtime_id"]: value.id,
    tenant_id: value.tenantId,
    project_id: value.projectId,
    workspace_id: value.workspaceId,
    sandbox_domain_id: value.domainId,
    owner_instance_id: value.ownerId,
    owner_base_url: value.ownerBaseUrl,
    runtime_id: value.runtimeId,
    runtime_name: value.runtimeName,
    runtime_capsule: value.capsule,
    provider_receipt: value.providerReceipt,
    ...(value.kind === "machine"
      ? {
          allocation_id: value.allocationId,
          desired_state: value.desiredState,
          intent_revision: value.intentRevision,
          generation: value.generation,
          environment_version_id: value.environmentVersionId,
          agent_activation_id: null,
          terminal_active: false,
        }
      : {}),
  };
  for (const [name, field] of Object.entries(fields))
    query = query.where(name, field === null ? "is" : "=", field);
  return query.where(
    sql`creation_spec is not distinct from ${value.creationSpec === null ? null : JSON.stringify(value.creationSpec)}::jsonb`,
  );
}

/** Existing ownership rows remain the cleanup intent. No operator lease/table,
 * source inventory mirror, Workspace mutation or network call lives here. */
export function createComputeRetirementRepository(database) {
  const transaction = (work) =>
    database.transaction().execute(async (tx) => {
      await sql`select set_config('lock_timeout','500ms',true),
      set_config('statement_timeout','2500ms',true), set_config('transaction_timeout','3000ms',true)`.execute(
        tx,
      );
      // Block fresh admission while checking and changing the durable record.
      // These short locks are released before the native network operation.
      await sql`lock table runs, session_leases, sandbox_tool_bindings,
      workspace_terminal_sessions, development_environments, workspace_runtimes,
      sandbox_control_instances, supervisor_connections in share row exclusive mode`.execute(tx);
      await assertDrained(tx);
      return work(tx);
    });
  return {
    assertDrained: () => assertDrained(database),
    async listTargets() {
      const machines = await sql`select m.*,
        w.id is not null and w.tenant_id=m.tenant_id as workspace_present,
        w.deleted_at as workspace_deleted_at
        from development_environments m left join workspaces w on w.id=m.workspace_id
        where m.state<>'released' order by m.id limit 1001`.execute(database);
      const elastic = await sql`select r.*,
        w.id is not null and w.tenant_id=r.tenant_id as workspace_present,
        w.deleted_at as workspace_deleted_at
        from workspace_runtimes r left join workspaces w on w.id=r.workspace_id
        where r.state<>'released' order by r.workspace_runtime_id limit 1001`.execute(database);
      assert(
        machines.rows.length + elastic.rows.length <= 1000,
        "Cold retirement inventory exceeds its reviewed single-host batch bound",
      );
      return [
        ...machines.rows
          .filter((row) => !maintenanceMachineRetired(row))
          .map((row) => target(row, "machine")),
        ...elastic.rows.map((row) => target(row, "elastic")),
      ];
    },
    async beginClose(value) {
      await transaction(async (tx) => {
        const result = await matching(tx.updateTable(tableFor(value)), value)
          .set({
            allocation_closed: true,
            state: value.kind === "machine" ? "reconciling" : "cleaning",
            updated_at: sql`clock_timestamp()`,
          })
          .where("state", "=", value.state)
          .where("allocation_closed", "=", value.allocationClosed)
          .executeTakeFirst();
        assert.equal(
          result.numUpdatedRows,
          1n,
          "Compute closure ownership changed before admission",
        );
      });
    },
    async assertCurrent(value) {
      const row = await matching(
        database.selectFrom(tableFor(value)).select("allocation_closed"),
        value,
      )
        .where("allocation_closed", "=", true)
        .where("state", "=", value.kind === "machine" ? "reconciling" : "cleaning")
        .executeTakeFirst();
      assert(row, "Compute closure ownership changed before the native effect");
    },
    async finishClose(value) {
      await transaction(async (tx) => {
        const result = await matching(tx.updateTable(tableFor(value)), value)
          .set({
            state: value.kind === "machine" ? "reconciling" : "released",
            runtime_id: null,
            runtime_name: null,
            runtime_capsule: null,
            provider_receipt: null,
            failure_code: null,
            updated_at: sql`clock_timestamp()`,
            ...(value.kind === "machine"
              ? {
                  allocation_absent: true,
                  agent_activation_id: null,
                  terminal_active: false,
                }
              : {}),
          })
          .where("allocation_closed", "=", true)
          .where("state", "=", value.kind === "machine" ? "reconciling" : "cleaning")
          .executeTakeFirst();
        assert.equal(
          result.numUpdatedRows,
          1n,
          "Compute ownership changed before absence settlement",
        );
        if (value.runtimeId !== null)
          await tx
            .updateTable("sandbox_http_services")
            .set({
              state: "ended",
              ended_at: sql`clock_timestamp()`,
              last_seen_at: sql`clock_timestamp()`,
            })
            .where("tenant_id", "=", value.tenantId)
            .where("workspace_id", "=", value.workspaceId)
            .where("runtime_id", "=", value.runtimeId)
            .where("state", "=", "active")
            .execute();
      });
    },
  };
}
