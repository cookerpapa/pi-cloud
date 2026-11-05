import type { WorkspaceFileTransferRequest } from "@pi-cloud/protocol";

/** Shared admission predicate for the owner and physical Volume gateway. Values
 * are parameters, never interpolated identifiers or a second progress authority. */
export function workspaceFileTransferGrantQuery(
  request: WorkspaceFileTransferRequest,
  owner?: { instanceId: string; sandboxDomainId: string },
) {
  const values: unknown[] = [
    request.uploadId,
    request.claimToken,
    request.tenantId,
    request.workspaceId,
    request.sessionId,
    request.sha256,
    request.name,
    request.byteLength,
    request.machine?.directory ??
      (request.rootPath ? `/workspace/${request.rootPath}` : "/workspace"),
    request.relativePath,
    request.createParents,
    request.machine?.environmentId ?? null,
    request.machine?.userId ?? null,
    request.expiresAt,
    request.action,
  ];
  let text = `select u.id from workspace_file_transfers u
    join sessions s on s.id=u.session_id and s.tenant_id=u.tenant_id
    join workspaces w on w.id=u.workspace_id and w.tenant_id=u.tenant_id
    where u.id=$1::uuid and u.claim_token=$2::uuid and u.tenant_id=$3::uuid
      and u.workspace_id=$4::uuid and u.session_id=$5::uuid and u.sha256=$6
      and u.name=$7 and u.byte_length=$8 and u.working_directory=$9
      and u.relative_path=$10 and u.create_parents=$11
      and u.development_environment_id is not distinct from $12::uuid
      and ($12::uuid is null or u.actor_user_id=$13::uuid)
      and ($15='cancel' or (u.state<>'cancelled' and u.expires_at>clock_timestamp()
        and u.expires_at >= $14::timestamptz and s.pruned_at is null
        and s.workspace_id=u.workspace_id and s.working_directory=u.working_directory
        and s.development_environment_id is not distinct from u.development_environment_id
        and (($12::uuid is null and s.execution_mode='elastic') or ($12::uuid is not null and s.execution_mode='development_environment'))))
      and w.deleted_at is null`;
  if (owner) {
    values.push(owner.instanceId, owner.sandboxDomainId);
    text += ` and w.sandbox_domain_id=$17 and exists(select 1 from sandbox_control_instances b
      where b.instance_id=$16::uuid and b.state='ready' and b.lease_expires_at>clock_timestamp())`;
  }
  return { text, values };
}
