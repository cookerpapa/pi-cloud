-- Applied in the SAME transaction as pg_restore, before the restored database
-- becomes visible. These are offline recovery changes, never live VM cleanup.
-- Exact schema is checked by the caller; no CASCADE and no native-log rewrites.
set local search_path=pg_catalog,public;
set constraints all immediate;
-- Lease identities are immutable online. This empty-target restore transaction
-- explicitly discards them; the source has already proved unsealed_runs=0.
alter table runs disable trigger runs_count_unsealed;
update runs set sandbox_id=null, lease_id=null, fencing_token=null,
  compute_session_id=null, recovery_requested_at=null, output_publication=null,
  output_first_topic=null, output_first_partition=null, output_first_offset=null,
  output_projected_offset=null, output_seal_id=null, output_seal_offset=null,
  output_sealed_at=null,
  input_return_request_id=null, queued_steer_id=null;
set constraints all immediate;
alter table runs enable trigger runs_count_unsealed;
update sessions set development_environment_id=null, compute_session_id=null,
  execution_mode='elastic', state='cold', working_directory='/workspace';
update source_control_issue_jobs set development_environment_id=null;

delete from outbox;
delete from accepted_fact_projection_offsets;
-- active_execution_scopes is a view over Runs/leases, not another authority.
delete from session_leases;
delete from sandbox_http_services;
delete from sandbox_tool_bindings;
delete from ssh_access_tickets;
delete from workspace_terminal_sessions;
delete from workspace_runtimes;
delete from development_environment_operations;
delete from development_environments;
delete from sandbox_control_instances;
delete from sandbox_retirements;
delete from supervisor_connections;
delete from supervisor_boot_credentials;
delete from sandboxes;
delete from supervisor_hosts;
delete from subagent_control_commands;
delete from subagent_supervisor_requests;
delete from turn_control_requests;
delete from gitlab_issue_note_sync;
delete from source_control_issue_claims;
delete from source_control_webhook_deliveries;
delete from source_control_issue_jobs;
delete from web_sessions;
delete from session_uploads;
delete from workspace_delete_operations;
delete from conversation_workspace_rebind_operations;

-- No restored row may ask the new controller to adopt/delete source storage.
-- Keep historical FK targets, but they are already purged in THIS installation.
update workspaces set deleted_at=coalesce(deleted_at,clock_timestamp()),
  storage_purged_at=clock_timestamp(), storage_purge_failures=0;
create temporary table recovered_workspaces on commit drop as
  select old_id,gen_random_uuid() as new_id
  from (select distinct workspace_id as old_id from sessions where pruned_at is null) s;
insert into workspaces(id,tenant_id,project_id,sandbox_domain_id,seed_kind,workspace_kind)
  select m.new_id,w.tenant_id,w.project_id,w.sandbox_domain_id,'empty','user'
  from recovered_workspaces m join workspaces w on w.id=m.old_id;
update sessions s set workspace_id=m.new_id from recovered_workspaces m
  where s.workspace_id=m.old_id and s.pruned_at is null;
update sandbox_domains d set assigned_workspaces=(select count(*) from workspaces w
  where w.sandbox_domain_id=d.id and w.deleted_at is null);
-- Source image uploads without durable reachability are not part of the bundle.
delete from session_image_objects o where not exists
  (select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id);
