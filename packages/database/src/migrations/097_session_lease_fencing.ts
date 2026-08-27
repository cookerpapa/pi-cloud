import { sql, type Kysely } from "kysely";

/**
 * Restore the explicit lease/fence vocabulary and remove the Tool Broker's
 * second, activation-local bearer. One Session lease is now the only Run
 * authority presented at every effect boundary.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table execution_grants rename to session_leases;
    alter table session_leases rename column grant_id to lease_id;
    alter table session_leases rename column generation to fencing_token;
    alter table session_leases rename column execution_id to attempt_id;
    alter table sessions rename column last_execution_generation to last_fencing_token;
    alter table run_attempts rename column execution_grant_id to lease_id;
    alter table run_attempts rename column execution_generation to fencing_token;
    alter table tool_broker_activations rename column execution_grant_id to lease_id;
    alter table tool_broker_activations rename column execution_generation to fencing_token;
    alter table tool_broker_activations drop column capability_sha256;
    alter table workspace_terminal_sessions rename column generation to fencing_token;

    alter table session_leases
      rename constraint execution_grants_pkey to session_leases_pkey;
    alter table session_leases
      rename constraint execution_grants_grant_id_key to session_leases_lease_id_key;
    alter table session_leases
      rename constraint execution_grants_generation_positive to session_leases_fencing_token_positive;
    alter table session_leases
      rename constraint execution_grants_expiry_valid to session_leases_expiry_valid;
    alter table session_leases
      rename constraint execution_grants_fact_channel_complete to session_leases_fact_channel_complete;

    alter index execution_grants_expiry rename to session_leases_expiry;
    alter index execution_grants_execution_unique rename to session_leases_attempt_unique;
    alter index execution_grants_fact_channel_connection_unique
      rename to session_leases_fact_channel_connection_unique;
    alter index execution_grants_fact_channel_expiry
      rename to session_leases_fact_channel_expiry
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter index session_leases_fact_channel_expiry
      rename to execution_grants_fact_channel_expiry;
    alter index session_leases_fact_channel_connection_unique
      rename to execution_grants_fact_channel_connection_unique;
    alter index session_leases_attempt_unique rename to execution_grants_execution_unique;
    alter index session_leases_expiry rename to execution_grants_expiry;

    alter table session_leases
      rename constraint session_leases_fact_channel_complete to execution_grants_fact_channel_complete;
    alter table session_leases
      rename constraint session_leases_expiry_valid to execution_grants_expiry_valid;
    alter table session_leases
      rename constraint session_leases_fencing_token_positive to execution_grants_generation_positive;
    alter table session_leases
      rename constraint session_leases_lease_id_key to execution_grants_grant_id_key;
    alter table session_leases
      rename constraint session_leases_pkey to execution_grants_pkey;

    alter table workspace_terminal_sessions rename column fencing_token to generation;
    alter table tool_broker_activations add column capability_sha256 char(64) not null default repeat('0', 64);
    alter table tool_broker_activations alter column capability_sha256 drop default;
    alter table tool_broker_activations rename column fencing_token to execution_generation;
    alter table tool_broker_activations rename column lease_id to execution_grant_id;
    alter table run_attempts rename column fencing_token to execution_generation;
    alter table run_attempts rename column lease_id to execution_grant_id;
    alter table sessions rename column last_fencing_token to last_execution_generation;
    alter table session_leases rename column attempt_id to execution_id;
    alter table session_leases rename column fencing_token to generation;
    alter table session_leases rename column lease_id to grant_id;
    alter table session_leases rename to execution_grants
  `.execute(db);
}
