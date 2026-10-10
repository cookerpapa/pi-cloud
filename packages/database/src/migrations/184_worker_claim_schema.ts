import { sql, type Kysely } from "kysely";

/** Matched Worker registry cleanup; ownership identities and evidence survive. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases,pi_sessions,sandboxes in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested'))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_sessions where unsealed_runs<>0)
      then raise exception 'Drain Runs, owners and seals before Worker schema cutover'; end if;
    end $$;

    create index run_transitions_run_history on run_transitions(tenant_id,run_id,occurred_at,id);
    alter table pi_sessions drop column created_at_ms, drop column parent_session_id, drop column name;

    alter table sandboxes rename to workers;
    alter table workers rename constraint sandboxes_pkey to workers_pkey;
    alter table workers rename constraint sandboxes_identity_unique to workers_identity_unique;
    alter table workers rename constraint sandboxes_max_concurrent_sessions_check to workers_max_concurrent_sessions_check;
    alter table workers rename constraint sandboxes_state_check to workers_state_check;
    alter table workers rename constraint sandboxes_terminated_at_matches_state to workers_terminated_at_matches_state;

    alter table session_leases rename column sandbox_id to worker_id;
    alter table session_leases rename constraint session_leases_sandbox_id_fkey to session_leases_worker_id_fkey;
    alter table runs rename constraint runs_sandbox_id_fkey to runs_worker_id_fkey;
    alter view active_execution_scopes rename column sandbox_id to worker_id;

    alter table supervisor_connections rename column sandbox_id to worker_id;
    alter table supervisor_connections rename constraint supervisor_connections_sandbox_identity_fk to supervisor_connections_worker_identity_fk;
    alter index supervisor_connections_one_active_per_sandbox rename to supervisor_connections_one_active_per_worker;
    alter table supervisor_boot_credentials rename column sandbox_id to worker_id;
    alter table supervisor_boot_credentials rename constraint supervisor_boot_credentials_sandbox_id_key to supervisor_boot_credentials_worker_id_key;
    alter table supervisor_boot_credentials rename constraint supervisor_boot_credentials_sandbox_identity_fk to supervisor_boot_credentials_worker_identity_fk;

    alter table sandbox_retirements rename to worker_retirements;
    alter table worker_retirements rename column sandbox_id to worker_id;
    alter table worker_retirements rename constraint sandbox_retirements_pkey to worker_retirements_pkey;
    alter table worker_retirements rename constraint sandbox_retirements_attempts_valid to worker_retirements_attempts_valid;
    alter table worker_retirements rename constraint sandbox_retirements_reason_valid to worker_retirements_reason_valid;
    alter table worker_retirements rename constraint sandbox_retirements_state_valid to worker_retirements_state_valid;
    alter table worker_retirements rename constraint sandbox_retirements_sandbox_identity_fk to worker_retirements_worker_identity_fk;
    alter index sandbox_retirements_available rename to worker_retirements_available;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Use a drained matched schema/runtime release to revert Worker naming");
}
