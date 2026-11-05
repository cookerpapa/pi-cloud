import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workspace_file_transfers (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      session_id uuid not null references sessions(id) on delete cascade,
      workspace_id uuid not null references workspaces(id) on delete cascade,
      actor_user_id uuid not null,
      working_directory text not null,
      development_environment_id uuid,
      name text not null check(length(name) between 1 and 200),
      relative_path text not null check(length(relative_path) between 1 and 4096),
      create_parents boolean not null,
      byte_length bigint not null check(byte_length>0 and byte_length<=9007199254740991),
      sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
      claim_token uuid not null,
      state text not null check(state in ('uploading','ready','cancelled')),
      cleanup_confirmed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      expires_at timestamptz not null
    );
    create index workspace_file_transfers_session on workspace_file_transfers(tenant_id,session_id,created_at);
    create index workspace_file_transfers_expiry on workspace_file_transfers(expires_at);
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Workspace transfers require matched API/Guest/Volume publication");
}
