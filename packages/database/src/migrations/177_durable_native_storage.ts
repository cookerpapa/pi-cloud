import { sql, type Kysely } from "kysely";

/** Native Durable batches and their derived query indexes. Runtime cutover is
 * matched separately; no application selects between old and new backends. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    create table pi_durable_commits (
      tenant_id uuid not null, session_id text not null, seq bigint not null check(seq>0),
      next_id bigint not null check(next_id>=2), fingerprint text not null, write_count int not null,
      committed_at timestamptz not null default clock_timestamp(),
      primary key(tenant_id,session_id,seq),
      foreign key(tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade
    );
    create table pi_durable_log (
      tenant_id uuid not null, session_id text not null, seq bigint not null, ordinal int not null,
      record_kind text not null, record_id bigint not null, body text not null, phase text, cloud_origin jsonb,
      primary key(tenant_id,session_id,seq,ordinal),
      foreign key(tenant_id,session_id,seq) references pi_durable_commits on delete cascade
    );
    create index pi_durable_log_record on pi_durable_log(tenant_id,session_id,record_id,seq desc,ordinal desc);
    create table pi_durable_records (
      tenant_id uuid not null, session_id text not null, id bigint not null, kind text not null,
      seq bigint not null, ordinal int not null, fields jsonb not null,
      created_seq bigint, retired_seq bigint,
      primary key(tenant_id,session_id,id),
      foreign key(tenant_id,session_id,seq,ordinal) references pi_durable_log on delete cascade
    );
    create index pi_durable_record_kind on pi_durable_records(tenant_id,session_id,kind,id);
    create index pi_durable_cloud_turn on pi_durable_records(tenant_id,(fields->>'turn'),kind,id);
    create index pi_durable_conversation_records on pi_durable_records(tenant_id,session_id,kind,(fields->>'conversation'),id);
    create index pi_durable_task_status on pi_durable_records(tenant_id,session_id,(fields->>'status'),id) where kind='task';
    create index pi_durable_task_kind on pi_durable_records(tenant_id,session_id,(fields->>'nativeKind'),id) where kind='task';
    create index pi_durable_submission_request on pi_durable_records(tenant_id,session_id,(fields->>'conversation'),(fields->>'request')) where kind='submission';
    create index pi_durable_owner_task on pi_durable_records(tenant_id,session_id,(fields->>'ownerTask'),id) where kind='conversation';
    create index pi_durable_owner_conversation on pi_durable_records(tenant_id,session_id,(fields->>'ownerConversation'),id) where kind='conversation';
    create index pi_durable_head on pi_durable_records(tenant_id,session_id,(fields->>'conversation'),id desc) where kind='entry' and fields ? 'head';
    create index pi_durable_document_scope on pi_durable_records(tenant_id,session_id,(fields->>'scope'),id) where kind='document';
    create index pi_durable_document_address on pi_durable_records(tenant_id,session_id,(fields->>'address'),created_seq desc) where kind='document';
    create unique index pi_durable_current_document on pi_durable_records(tenant_id,session_id,(fields->>'address')) where kind='document' and retired_seq is null;
    create table pi_durable_document_revisions (
      tenant_id uuid not null, session_id text not null, document_id bigint not null,
      seq bigint not null, ordinal int not null, kind text not null, version int not null,
      delta_count int not null, checkpoint text,
      primary key(tenant_id,session_id,document_id,seq),
      foreign key(tenant_id,session_id,seq,ordinal) references pi_durable_log on delete cascade
    );
    create index pi_durable_document_base on pi_durable_document_revisions(tenant_id,session_id,document_id,seq desc)
      where kind='base' or checkpoint is not null;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore matching native storage and runtime artifacts before reverting Durable storage",
  );
}
