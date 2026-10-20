import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    create table session_upload_pins (
      pin_id uuid not null,
      upload_id uuid not null references session_uploads(id) on delete cascade,
      tenant_id uuid not null references tenants(id),
      pi_session_id text not null,
      conversation_id bigint not null check(conversation_id>0),
      run_id uuid not null references runs(id) on delete cascade,
      writer_id uuid not null,
      kind text not null check(kind in ('submit','mutate')),
      operation_id text not null check(length(operation_id) between 1 and 256),
      fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
      reconcile_after timestamptz not null default clock_timestamp()+interval '1 minute',
      primary key(pin_id,upload_id),
      foreign key(tenant_id,pi_session_id) references pi_sessions(tenant_id,id) on delete cascade
    );
    create index session_upload_pins_upload on session_upload_pins(upload_id);
    create index session_upload_pins_reconcile on session_upload_pins(reconcile_after,pin_id);
    alter table session_image_objects add column write_completed_at timestamptz;
    update session_image_objects set write_completed_at=created_at where state='ready';
  `.execute(db);
}
export async function down<DB>(_db: Kysely<DB>): Promise<void> {
  throw new Error("Upload lifetime metadata requires a drained matched upgrade");
}
