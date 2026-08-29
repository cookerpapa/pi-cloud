import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table agent_definitions (
      id uuid primary key,
      key text not null unique check (key ~ '^[a-z][a-z0-9-]{0,62}$'),
      display_name text not null check (char_length(display_name) between 1 and 128),
      created_at timestamptz not null default now()
    );

    create table agent_revisions (
      id uuid primary key,
      definition_id uuid not null references agent_definitions(id),
      revision_number integer not null check (revision_number > 0),
      runtime_kind text not null check (runtime_kind in ('pi_sdk')),
      runtime_version text not null check (char_length(runtime_version) between 1 and 128),
      harness_version text not null check (char_length(harness_version) between 1 and 128),
      session_storage_kind text not null check (session_storage_kind in ('pi_session_storage_v1')),
      state text not null check (state in ('active', 'retired')),
      created_at timestamptz not null default now(),
      unique (definition_id, revision_number)
    );

    insert into agent_definitions (id, key, display_name)
    values ('904b0a62-f7ab-4da6-a86a-1328f76d1eea'::uuid, 'pi-coding', 'Pi Coding Agent');

    insert into agent_revisions (
      id, definition_id, revision_number, runtime_kind, runtime_version,
      harness_version, session_storage_kind, state
    ) values (
      '84041f7b-5052-4abf-8bfd-16adf083c67e'::uuid,
      '904b0a62-f7ab-4da6-a86a-1328f76d1eea'::uuid, 1,
      'pi_sdk', '0.84.1', 'pi-cloud-harness-v1', 'pi_session_storage_v1', 'active'
    );

    alter table sessions
      add column agent_revision_id uuid not null
        default '84041f7b-5052-4abf-8bfd-16adf083c67e'::uuid
        references agent_revisions(id);

    alter table runs
      add column agent_revision_id uuid not null
        default '84041f7b-5052-4abf-8bfd-16adf083c67e'::uuid
        references agent_revisions(id);

    create index runs_agent_queue_idx
      on runs (agent_revision_id, available_at, queued_at, id)
      where state in ('queued', 'claimed');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists runs_agent_queue_idx;
    alter table runs drop column agent_revision_id;
    alter table sessions drop column agent_revision_id;
    drop table agent_revisions;
    drop table agent_definitions;
  `.execute(db);
}
