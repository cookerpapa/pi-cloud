import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table external_identities (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      user_id uuid not null,
      provider_key text not null check (provider_key ~ '^[a-z][a-z0-9-]{0,62}$'),
      issuer text not null check (issuer ~ '^https?://[^/[:space:]]+$'),
      subject text not null check (char_length(subject) between 1 and 512),
      provider_user_id text not null check (char_length(provider_user_id) between 1 and 128),
      username text not null check (char_length(username) between 1 and 255),
      display_name text not null check (char_length(display_name) between 1 and 256),
      last_authenticated_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, user_id) references users(tenant_id, id),
      unique (provider_key, issuer, subject),
      unique (tenant_id, user_id, id),
      unique (tenant_id, user_id, provider_key, issuer)
    );

    create table oidc_authentication_requests (
      state_sha256 char(64) primary key check (state_sha256 ~ '^[0-9a-f]{64}$'),
      provider_key text not null check (provider_key ~ '^[a-z][a-z0-9-]{0,62}$'),
      code_verifier text not null check (char_length(code_verifier) between 43 and 128),
      nonce text not null check (char_length(nonce) between 32 and 128),
      redirect_uri text not null check (char_length(redirect_uri) between 8 and 2048),
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      check (expires_at > created_at),
      check (consumed_at is null or consumed_at >= created_at)
    );

    create index oidc_authentication_requests_expiry_idx
      on oidc_authentication_requests (expires_at)
      where consumed_at is null;

    alter table web_sessions
      add column authentication_kind text not null default 'local'
        check (authentication_kind in ('local', 'oidc')),
      add column external_identity_id uuid,
      add constraint web_sessions_external_identity_fk
        foreign key (tenant_id, user_id, external_identity_id)
        references external_identities(tenant_id, user_id, id),
      add constraint web_sessions_authentication_shape
        check (
          (authentication_kind = 'local' and external_identity_id is null)
          or (authentication_kind = 'oidc' and external_identity_id is not null)
        );

    alter table sessions
      add column created_by_user_id uuid,
      add constraint sessions_created_by_user_fk
        foreign key (tenant_id, created_by_user_id) references users(tenant_id, id);

    update source_control_issue_jobs
       set state = 'cancelled',
           failure_code = coalesce(failure_code, 'issue_workflow_upgraded'),
           failure_message = coalesce(failure_message, 'Issue request must be submitted again'),
           owner_id = null,
           lease_expires_at = null,
           settled_at = coalesce(settled_at, now()),
           updated_at = now()
     where state not in ('completed', 'failed', 'cancelled');

    alter table source_control_issue_jobs
      drop constraint source_control_issue_jobs_state_check,
      add constraint source_control_issue_jobs_state_check
        check (
          state in (
            'awaiting_claim', 'received', 'provisioning', 'queued', 'running',
            'publishing', 'completed', 'failed', 'cancelled'
          )
        ),
      add column claim_sync_pending boolean not null default false,
      add column started_by_user_id uuid,
      add column execution_mode text check (
        execution_mode is null or execution_mode in ('elastic', 'development_environment')
      ),
      add column sandbox_profile_key text check (
        sandbox_profile_key is null or sandbox_profile_key in ('starter', 'standard', 'performance')
      ),
      add column development_environment_id uuid,
      add column working_directory text check (
        working_directory is null or (
          char_length(working_directory) between 1 and 4096 and left(working_directory, 1) = '/'
        )
      ),
      add constraint source_control_issue_jobs_started_by_fk
        foreign key (tenant_id, started_by_user_id) references users(tenant_id, id),
      add constraint source_control_issue_jobs_environment_fk
        foreign key (tenant_id, development_environment_id)
        references development_environments(tenant_id, id),
      add constraint source_control_issue_jobs_tenant_identity_unique
        unique (tenant_id, id);

    create table source_control_issue_claims (
      tenant_id uuid not null references tenants(id),
      issue_job_id uuid not null,
      user_id uuid not null,
      external_identity_id uuid not null,
      claimed_at timestamptz not null default now(),
      primary key (issue_job_id, user_id),
      foreign key (tenant_id, issue_job_id)
        references source_control_issue_jobs(tenant_id, id) on delete cascade,
      foreign key (tenant_id, user_id) references users(tenant_id, id),
      foreign key (tenant_id, user_id, external_identity_id)
        references external_identities(tenant_id, user_id, id)
    );

    create index source_control_issue_claims_tenant_user_idx
      on source_control_issue_claims (tenant_id, user_id, claimed_at desc);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table source_control_issue_claims;

    alter table source_control_issue_jobs
      drop constraint source_control_issue_jobs_tenant_identity_unique,
      drop constraint source_control_issue_jobs_environment_fk,
      drop constraint source_control_issue_jobs_started_by_fk,
      drop column working_directory,
      drop column development_environment_id,
      drop column sandbox_profile_key,
      drop column execution_mode,
      drop column started_by_user_id,
      drop column claim_sync_pending,
      drop constraint source_control_issue_jobs_state_check,
      add constraint source_control_issue_jobs_state_check
        check (
          state in (
            'received', 'provisioning', 'queued', 'running',
            'publishing', 'completed', 'failed', 'cancelled'
          )
        );

    alter table sessions
      drop constraint sessions_created_by_user_fk,
      drop column created_by_user_id;

    alter table web_sessions
      drop constraint web_sessions_authentication_shape,
      drop constraint web_sessions_external_identity_fk,
      drop column external_identity_id,
      drop column authentication_kind;

    drop index oidc_authentication_requests_expiry_idx;
    drop table oidc_authentication_requests;
    drop table external_identities;
  `.execute(db);
}
