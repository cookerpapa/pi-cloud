import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  // Matched schema/API cutover. Refuse to erase hidden history with active work.
  await sql`
    lock table sessions, runs, subagent_executions, pi_sessions, session_leases
      in share row exclusive mode;
    alter table conversation_fork_operations drop constraint conversation_fork_operations_source_turn_id_fkey,
      add constraint conversation_fork_operations_source_turn_id_fkey FOREIGN KEY (source_turn_id) REFERENCES turns(id) ON DELETE CASCADE;
    alter table conversation_fork_operations drop constraint conversation_fork_operations_tenant_id_child_session_id_fkey,
      add constraint conversation_fork_operations_tenant_id_child_session_id_fkey FOREIGN KEY (tenant_id, child_session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table conversation_fork_operations drop constraint conversation_fork_operations_tenant_id_source_session_id_fkey,
      add constraint conversation_fork_operations_tenant_id_source_session_id_fkey FOREIGN KEY (tenant_id, source_session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table conversation_prune_operations drop constraint conversation_prune_operations_session_fk,
      add constraint conversation_prune_operations_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table conversation_prune_operations drop constraint conversation_prune_operations_turn_fk,
      add constraint conversation_prune_operations_turn_fk FOREIGN KEY (tenant_id, session_id, anchor_turn_id) REFERENCES turns(tenant_id, session_id, id) ON DELETE CASCADE;
    alter table conversation_workspace_rebind_operations drop constraint conversation_workspace_rebind_session_fk,
      add constraint conversation_workspace_rebind_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table environment_validations drop constraint environment_validations_run_fk,
      add constraint environment_validations_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;
    alter table run_transitions drop constraint run_transitions_tenant_id_run_id_fkey,
      add constraint run_transitions_tenant_id_run_id_fkey FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;
    alter table runs drop constraint runs_tenant_session_fk,
      add constraint runs_tenant_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table runs drop constraint runs_tenant_turn_fk,
      add constraint runs_tenant_turn_fk FOREIGN KEY (tenant_id, session_id, turn_id) REFERENCES turns(tenant_id, session_id, id) ON DELETE CASCADE;
    alter table sandbox_http_services drop constraint sandbox_http_services_session_fk,
      add constraint sandbox_http_services_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table session_terminal_events drop constraint session_terminal_events_run_fk,
      add constraint session_terminal_events_run_fk FOREIGN KEY (tenant_id, session_id, turn_id, run_id) REFERENCES runs(tenant_id, session_id, turn_id, id) ON DELETE CASCADE;
    alter table sessions drop constraint sessions_conversation_fork_turn_fk,
      add constraint sessions_conversation_fork_turn_fk FOREIGN KEY (conversation_fork_turn_id) REFERENCES turns(id) ON DELETE SET NULL;
    alter table sessions drop constraint sessions_forked_from_fk,
      add constraint sessions_forked_from_fk FOREIGN KEY (tenant_id, forked_from_session_id) REFERENCES sessions(tenant_id, id) ON DELETE SET NULL (forked_from_session_id);
    alter table source_control_issue_jobs drop constraint source_control_issue_jobs_run_id_fkey,
      add constraint source_control_issue_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
    alter table source_control_issue_jobs drop constraint source_control_issue_jobs_tenant_id_session_id_fkey,
      add constraint source_control_issue_jobs_tenant_id_session_id_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table source_control_webhook_deliveries drop constraint source_control_webhook_issue_job_fk,
      add constraint source_control_webhook_issue_job_fk FOREIGN KEY (issue_job_id) REFERENCES source_control_issue_jobs(id) ON DELETE SET NULL;
    alter table ssh_access_tickets drop constraint ssh_access_tickets_session_fk,
      add constraint ssh_access_tickets_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_child_run_fk,
      add constraint subagent_executions_child_run_fk FOREIGN KEY (tenant_id, child_run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_child_session_fk,
      add constraint subagent_executions_child_session_fk FOREIGN KEY (tenant_id, child_session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_parent_execution_fk,
      add constraint subagent_executions_parent_execution_fk FOREIGN KEY (tenant_id, parent_execution_id) REFERENCES subagent_executions(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_parent_run_fk,
      add constraint subagent_executions_parent_run_fk FOREIGN KEY (tenant_id, parent_run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_parent_session_fk,
      add constraint subagent_executions_parent_session_fk FOREIGN KEY (tenant_id, parent_session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_root_run_fk,
      add constraint subagent_executions_root_run_fk FOREIGN KEY (tenant_id, root_run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_executions drop constraint subagent_executions_root_session_fk,
      add constraint subagent_executions_root_session_fk FOREIGN KEY (tenant_id, root_session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table subagent_supervisor_requests drop constraint subagent_supervisor_requests_execution_fk,
      add constraint subagent_supervisor_requests_execution_fk FOREIGN KEY (tenant_id, execution_id) REFERENCES subagent_executions(tenant_id, id) ON DELETE CASCADE;
    alter table tool_broker_workspace_runtimes drop constraint tool_broker_workspace_runtimes_bootstrap_run_fk;
    alter table tool_broker_workspace_runtimes drop constraint tool_broker_workspace_runtimes_bootstrap_session_fk;
    alter table tool_broker_workspace_runtimes drop constraint tool_broker_workspace_runtimes_bootstrap_turn_fk;
    alter table turn_control_requests drop constraint turn_control_requests_session_id_fkey,
      add constraint turn_control_requests_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
    alter table turn_control_requests drop constraint turn_control_requests_target_run_id_fkey,
      add constraint turn_control_requests_target_run_id_fkey FOREIGN KEY (target_run_id) REFERENCES runs(id) ON DELETE CASCADE;
    alter table turn_control_requests drop constraint turn_control_requests_tenant_id_session_id_turn_id_fkey,
      add constraint turn_control_requests_tenant_id_session_id_turn_id_fkey FOREIGN KEY (tenant_id, session_id, turn_id) REFERENCES turns(tenant_id, session_id, id) ON DELETE CASCADE;
    alter table turn_control_requests drop constraint turn_control_requests_turn_id_fkey,
      add constraint turn_control_requests_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE;
    alter table turns drop constraint turns_tenant_session_fk,
      add constraint turns_tenant_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    alter table workspace_terminal_sessions drop constraint workspace_terminal_session_fk,
      add constraint workspace_terminal_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE;
    drop table workspace_operations;

    create temporary table pi_cloud_deleted_sessions on commit drop as
      with recursive hidden as (
        select tenant_id,id,pi_session_id from sessions
          where session_kind='conversation' and archived_at is not null
        union
        select child.tenant_id,child.id,child.pi_session_id from sessions child join hidden parent
          on child.tenant_id=parent.tenant_id and
            (child.conversation_parent_session_id=parent.id or
              (child.session_kind='subagent' and child.pi_session_id=parent.pi_session_id))
      ) select * from hidden;
    do $$ begin
      if exists(select 1 from sessions s join pi_cloud_deleted_sessions d
        on d.tenant_id=s.tenant_id and d.id=s.id where s.state not in ('cold','idle','failed'))
      or exists(select 1 from runs r join pi_cloud_deleted_sessions d
        on d.tenant_id=r.tenant_id and d.id=r.session_id
        where r.state in ('queued','running','settling','cancel_requested')
          or (r.lease_id is not null and r.output_sealed_at is null))
      or exists(select 1 from subagent_executions e join pi_cloud_deleted_sessions d
        on d.tenant_id=e.tenant_id and d.id=e.child_session_id
        where e.state in ('preparing','queued','running'))
      or exists(select 1 from pi_sessions p join pi_cloud_deleted_sessions d
        on d.tenant_id=p.tenant_id and d.pi_session_id=p.id where p.unsealed_runs<>0)
      or exists(select 1 from session_leases l join pi_cloud_deleted_sessions d
        on d.tenant_id=l.tenant_id and d.pi_session_id=l.pi_session_id where l.released_at is null)
      or exists(select 1 from sessions s join pi_cloud_deleted_sessions d
        on d.tenant_id=s.tenant_id and d.pi_session_id=s.pi_session_id
        where not exists(select 1 from pi_cloud_deleted_sessions own
          where own.tenant_id=s.tenant_id and own.id=s.id)) then
        raise exception 'Hidden conversations must quiesce before permanent deletion migration';
      end if;
    end $$;
    delete from outbox o using runs r, pi_cloud_deleted_sessions d
      where o.tenant_id=r.tenant_id and o.id=r.output_seal_id
        and o.aggregate_type='session_terminal_event'
        and d.tenant_id=r.tenant_id and d.id=r.session_id;
    delete from sessions s using pi_cloud_deleted_sessions d
      where s.tenant_id=d.tenant_id and s.id=d.id;
    delete from session_leases l using pi_cloud_deleted_sessions d
      where l.tenant_id=d.tenant_id and l.pi_session_id=d.pi_session_id and l.released_at is not null;
    delete from pi_sessions p using pi_cloud_deleted_sessions d
      where p.tenant_id=d.tenant_id and p.id=d.pi_session_id;
    alter table sessions rename column archived_at to pruned_at;
    alter table conversation_prune_operations rename column archived_session_count to pruned_session_count;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Permanent deletion requires restoring a matched database backup");
}
