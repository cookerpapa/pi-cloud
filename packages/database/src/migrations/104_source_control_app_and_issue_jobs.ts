import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table source_control_installation_requests (
      state_sha256 char(64) primary key check (state_sha256 ~ '^[0-9a-f]{64}$'),
      tenant_id uuid not null references tenants(id),
      user_id uuid not null,
      provider text not null check (provider in ('github')),
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      foreign key (tenant_id, user_id) references users(tenant_id, id),
      check (expires_at > created_at),
      check (consumed_at is null or consumed_at >= created_at)
    );

    create index source_control_installation_requests_expiry_idx
      on source_control_installation_requests (expires_at)
      where consumed_at is null;

    create table source_control_installations (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      connected_by_user_id uuid not null,
      provider text not null check (provider in ('github')),
      provider_installation_id text not null check (provider_installation_id ~ '^[1-9][0-9]{0,30}$'),
      account_id text not null check (account_id ~ '^[1-9][0-9]{0,30}$'),
      account_login text not null check (char_length(account_login) between 1 and 255),
      account_type text not null check (account_type in ('User', 'Organization', 'Enterprise')),
      repository_selection text not null check (repository_selection in ('all', 'selected')),
      state text not null check (state in ('active', 'suspended', 'deleted')),
      suspended_at timestamptz,
      installed_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, connected_by_user_id) references users(tenant_id, id),
      unique (provider, provider_installation_id),
      unique (tenant_id, id),
      check ((state = 'suspended') = (suspended_at is not null))
    );

    create index source_control_installations_tenant_idx
      on source_control_installations (tenant_id, state, account_login);

    create table source_control_repositories (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      installation_id uuid not null,
      provider text not null check (provider in ('github')),
      provider_repository_id text not null check (provider_repository_id ~ '^[1-9][0-9]{0,30}$'),
      owner text not null check (char_length(owner) between 1 and 255),
      name text not null check (char_length(name) between 1 and 255),
      full_name text not null check (
        char_length(full_name) between 3 and 511 and
        full_name = owner || '/' || name
      ),
      private boolean not null,
      default_branch text not null check (char_length(default_branch) between 1 and 255),
      clone_url text not null check (
        clone_url ~ '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\\.git$'
      ),
      state text not null check (state in ('active', 'removed')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, installation_id)
        references source_control_installations(tenant_id, id),
      unique (provider, provider_repository_id),
      unique (tenant_id, id),
      unique (tenant_id, full_name)
    );

    create index source_control_repositories_installation_idx
      on source_control_repositories (installation_id, state, full_name);

    create table workspace_source_repositories (
      tenant_id uuid not null references tenants(id),
      workspace_id uuid primary key,
      repository_id uuid not null,
      base_ref text not null check (char_length(base_ref) between 1 and 255),
      base_sha char(40) check (base_sha is null or base_sha ~ '^[0-9a-f]{40}$'),
      checkout_state text not null check (checkout_state in ('provisioning', 'ready', 'failed')),
      failure_code text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
      foreign key (tenant_id, repository_id)
        references source_control_repositories(tenant_id, id),
      check ((checkout_state = 'failed') = (failure_code is not null))
    );

    create table source_control_webhook_deliveries (
      provider text not null check (provider in ('github')),
      delivery_id text not null check (char_length(delivery_id) between 1 and 128),
      event_name text not null check (char_length(event_name) between 1 and 64),
      action text check (action is null or char_length(action) between 1 and 64),
      payload_sha256 char(64) not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
      installation_id uuid,
      repository_id uuid,
      state text not null check (state in ('received', 'ignored', 'accepted', 'completed', 'failed')),
      issue_job_id uuid,
      failure_code text,
      received_at timestamptz not null default now(),
      settled_at timestamptz,
      primary key (provider, delivery_id),
      foreign key (installation_id) references source_control_installations(id),
      foreign key (repository_id) references source_control_repositories(id),
      check ((state in ('completed', 'failed', 'ignored')) = (settled_at is not null)),
      check ((state = 'failed') = (failure_code is not null))
    );

    create table source_control_issue_jobs (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      provider text not null check (provider in ('github')),
      webhook_delivery_id text not null,
      repository_id uuid not null,
      issue_number integer not null check (issue_number > 0),
      issue_title text not null check (char_length(issue_title) between 1 and 512),
      issue_body text not null check (octet_length(issue_body) <= 100000),
      issue_url text not null check (char_length(issue_url) between 8 and 2048),
      trigger_kind text not null check (trigger_kind in ('label', 'comment')),
      trigger_actor text not null check (char_length(trigger_actor) between 1 and 255),
      state text not null check (
        state in ('received', 'provisioning', 'queued', 'running', 'publishing', 'completed', 'failed', 'cancelled')
      ),
      project_id uuid,
      workspace_id uuid,
      session_id uuid,
      run_id uuid,
      branch_name text not null check (char_length(branch_name) between 1 and 255),
      commit_sha char(40) check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
      pull_request_number integer check (pull_request_number is null or pull_request_number > 0),
      pull_request_url text check (pull_request_url is null or char_length(pull_request_url) between 8 and 2048),
      issue_comment_id text check (issue_comment_id is null or issue_comment_id ~ '^[1-9][0-9]{0,30}$'),
      owner_id text,
      lease_expires_at timestamptz,
      attempt_count integer not null default 0 check (attempt_count >= 0),
      failure_code text,
      failure_message text,
      available_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      settled_at timestamptz,
      foreign key (tenant_id, repository_id)
        references source_control_repositories(tenant_id, id),
      foreign key (provider, webhook_delivery_id)
        references source_control_webhook_deliveries(provider, delivery_id),
      foreign key (tenant_id, project_id) references projects(tenant_id, id),
      foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
      foreign key (tenant_id, session_id) references sessions(tenant_id, id),
      foreign key (run_id) references runs(id),
      unique (provider, webhook_delivery_id),
      unique (repository_id, issue_number, branch_name),
      check ((state in ('completed', 'failed', 'cancelled')) = (settled_at is not null)),
      check ((state = 'failed') = (failure_code is not null))
      ,check ((owner_id is null) = (lease_expires_at is null))
    );

    alter table source_control_webhook_deliveries
      add constraint source_control_webhook_issue_job_fk
      foreign key (issue_job_id) references source_control_issue_jobs(id);

    create index source_control_issue_jobs_ready_idx
      on source_control_issue_jobs (available_at, lease_expires_at, created_at, id)
      where state not in ('completed', 'failed', 'cancelled');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table source_control_webhook_deliveries
      drop constraint if exists source_control_webhook_issue_job_fk;
    drop table if exists source_control_issue_jobs;
    drop table if exists source_control_webhook_deliveries;
    drop table if exists workspace_source_repositories;
    drop table if exists source_control_repositories;
    drop table if exists source_control_installations;
    drop table if exists source_control_installation_requests;
  `.execute(db);
}
