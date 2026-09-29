import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_uploads (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      session_id uuid not null references sessions(id) on delete cascade,
      pi_session_id text not null,
      workspace_id uuid not null references workspaces(id),
      actor_user_id uuid not null references users(id),
      working_directory text not null,
      name text not null check(length(name) between 1 and 200),
      path text not null,
      mime_type text not null,
      byte_length bigint not null check(byte_length between 1 and 16777216),
      sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
      state text not null check(state in ('uploading','ready','failed')),
      claim_token uuid not null,
      lease_expires_at timestamptz not null,
      image_id uuid,
      image_reference jsonb,
      accepted_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      expires_at timestamptz not null,
      foreign key(tenant_id,pi_session_id) references pi_sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,image_id) references session_image_objects(tenant_id,id),
      check((image_id is null)=(image_reference is null))
    );
    create index session_uploads_session on session_uploads(tenant_id,session_id,created_at);
    create index session_uploads_image on session_uploads(tenant_id,image_id) where image_id is not null;
    create index session_uploads_expiry on session_uploads(expires_at) where accepted_at is null;
    alter table turns add column input_uploads jsonb not null default '[]'::jsonb
      check(jsonb_typeof(input_uploads)='array' and jsonb_array_length(input_uploads)<=4);
    alter table turns drop constraint turns_input_valid;
    alter table turns add constraint turns_input_valid check(input_kind='prompt' and input_text is not null
      and (char_length(input_text)>0 or jsonb_array_length(input_uploads)>0));
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Restore matched input/attachment metadata; input image rollback is unsupported");
}
