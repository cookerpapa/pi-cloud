import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table source_control_installation_requests
      drop constraint source_control_installation_requests_provider_check,
      add constraint source_control_installation_requests_provider_check
        check (provider in ('github', 'gitlab'));

    alter table source_control_installations
      drop constraint source_control_installations_provider_check,
      drop constraint source_control_installations_provider_provider_installation_key,
      add column provider_base_url text not null default 'https://github.com',
      add constraint source_control_installations_provider_check
        check (provider in ('github', 'gitlab')),
      add constraint source_control_installations_provider_base_url_check
        check (provider_base_url ~ '^https?://[^/[:space:]]+$'),
      add constraint source_control_installations_provider_identity_unique
        unique (provider, provider_base_url, provider_installation_id);

    alter table source_control_repositories
      drop constraint source_control_repositories_provider_check,
      drop constraint source_control_repositories_clone_url_check,
      drop constraint source_control_repositories_provider_provider_repository_id_key,
      drop constraint source_control_repositories_tenant_id_full_name_key,
      add column provider_base_url text not null default 'https://github.com',
      add constraint source_control_repositories_provider_check
        check (provider in ('github', 'gitlab')),
      add constraint source_control_repositories_provider_base_url_check
        check (provider_base_url ~ '^https?://[^/[:space:]]+$'),
      add constraint source_control_repositories_clone_url_check
        check (
          clone_url ~ '^https?://[^/[:space:]@]+/.+\\.git$'
          and clone_url !~ '[[:cntrl:][:space:]]'
        ),
      add constraint source_control_repositories_provider_identity_unique
        unique (provider, provider_base_url, provider_repository_id),
      add constraint source_control_repositories_tenant_identity_unique
        unique (tenant_id, provider, provider_base_url, full_name);

    alter table source_control_webhook_deliveries
      drop constraint source_control_webhook_deliveries_provider_check,
      add constraint source_control_webhook_deliveries_provider_check
        check (provider in ('github', 'gitlab'));

    alter table source_control_issue_jobs
      drop constraint source_control_issue_jobs_provider_check,
      add constraint source_control_issue_jobs_provider_check
        check (provider in ('github', 'gitlab'));

    alter table source_control_issue_jobs
      rename column pull_request_number to change_request_number;

    alter table source_control_issue_jobs
      rename column pull_request_url to change_request_url;

    create table source_control_credentials (
      tenant_id uuid not null references tenants(id),
      installation_id uuid primary key,
      provider text not null check (provider in ('gitlab')),
      version integer not null check (version > 0),
      key_version integer not null check (key_version > 0),
      nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{16}$'),
      ciphertext text not null check (
        char_length(ciphertext) between 16 and 16384 and ciphertext ~ '^[A-Za-z0-9_-]+$'
      ),
      auth_tag text not null check (auth_tag ~ '^[A-Za-z0-9_-]{22}$'),
      secret_sha256 char(64) not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, installation_id)
        references source_control_installations(tenant_id, id) on delete cascade
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table source_control_credentials;

    alter table source_control_issue_jobs
      rename column change_request_url to pull_request_url;
    alter table source_control_issue_jobs
      rename column change_request_number to pull_request_number;
    alter table source_control_issue_jobs
      drop constraint source_control_issue_jobs_provider_check,
      add constraint source_control_issue_jobs_provider_check check (provider = 'github');

    alter table source_control_webhook_deliveries
      drop constraint source_control_webhook_deliveries_provider_check,
      add constraint source_control_webhook_deliveries_provider_check check (provider = 'github');

    alter table source_control_repositories
      drop constraint source_control_repositories_tenant_identity_unique,
      drop constraint source_control_repositories_provider_identity_unique,
      drop constraint source_control_repositories_clone_url_check,
      drop constraint source_control_repositories_provider_base_url_check,
      drop constraint source_control_repositories_provider_check,
      drop column provider_base_url,
      add constraint source_control_repositories_provider_check check (provider = 'github'),
      add constraint source_control_repositories_clone_url_check
        check (clone_url ~ '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.git$'),
      add constraint source_control_repositories_provider_provider_repository_id_key
        unique (provider, provider_repository_id),
      add constraint source_control_repositories_tenant_id_full_name_key
        unique (tenant_id, full_name);

    alter table source_control_installations
      drop constraint source_control_installations_provider_identity_unique,
      drop constraint source_control_installations_provider_base_url_check,
      drop constraint source_control_installations_provider_check,
      drop column provider_base_url,
      add constraint source_control_installations_provider_check check (provider = 'github'),
      add constraint source_control_installations_provider_provider_installation_key
        unique (provider, provider_installation_id);

    alter table source_control_installation_requests
      drop constraint source_control_installation_requests_provider_check,
      add constraint source_control_installation_requests_provider_check check (provider = 'github');
  `.execute(db);
}
