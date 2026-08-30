import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop table workspace_git_oauth_requests;

    drop table source_control_issue_claims;
    create table source_control_issue_claims (
      tenant_id uuid not null references tenants(id),
      issue_job_id uuid not null,
      user_id uuid not null,
      username text not null check (char_length(username) between 1 and 255),
      display_name text not null check (char_length(display_name) between 1 and 256),
      claimed_at timestamptz not null default now(),
      primary key (issue_job_id, user_id),
      foreign key (tenant_id, issue_job_id)
        references source_control_issue_jobs(tenant_id, id) on delete cascade,
      foreign key (tenant_id, user_id) references users(tenant_id, id)
    );
    create index source_control_issue_claims_tenant_user_idx
      on source_control_issue_claims (tenant_id, user_id, claimed_at desc);

    update source_control_issue_jobs
       set claim_sync_pending = false
     where claim_sync_pending = true;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "114_decoupled_code_host_connections is destructive; restore a pre-migration backup to roll back",
  );
}
