import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { parseConversationEnvironment, type ConversationEnvironment } from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

export async function readConversationEnvironment(
  database: Kysely<Database>,
  tenant: string,
  session: string,
): Promise<ConversationEnvironment> {
  const { rows } =
    await sql<ConversationEnvironment>`select s.id as "sessionId", s.workspace_id as "workspaceId",
    s.working_directory as "workingDirectory", s.execution_mode as "executionMode",
    s.development_environment_id as "developmentEnvironmentId",
    case when b.binding_id is null then null else jsonb_build_object('bindingId',b.binding_id,
      'allocationId',b.snapshot->>'physicalActivationId','admission',case when not b.dispatch_closed then 'open'
        when exists(select 1 from outbox o where o.aggregate_id=b.binding_id and o.applied_at is null
          and o.topic='session.control.changed.v1' and o.payload->>'entity'='sandbox_binding'
          and o.payload->>'closed'='true') then 'closing' else 'closed' end) end as binding
    from sessions s left join lateral (
      select b.binding_id,b.snapshot,b.dispatch_closed from sandbox_tool_bindings b
      join session_leases l on l.lease_id=b.writer_id and l.tenant_id=b.tenant_id and l.released_at is null
      where b.tenant_id=s.tenant_id and b.pi_session_id=s.pi_session_id
        and b.snapshot->'assignment'->>'sessionId'=s.id::text
      order by b.revision desc limit 1
    ) b on true where s.tenant_id=${tenant}::uuid and s.id=${session}::uuid and s.pruned_at is null`.execute(
      database,
    );
  if (!rows[0]) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
  return parseConversationEnvironment(rows[0]);
}
