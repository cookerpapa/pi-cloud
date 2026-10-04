import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, workspace_runtimes, development_environments, workspace_terminal_sessions in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('queued','completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from workspace_runtimes where state in ('materializing','active','warm','cleaning'))
        or exists(select 1 from development_environments where state in ('provisioning','running','paused','releasing'))
        or exists(select 1 from workspace_terminal_sessions where state in ('materializing','active','cleaning'))
      then raise exception 'Drain executions and leases before recoverable VM allocation'; end if;
    end $$;
    alter table workspace_runtimes
      add column allocation_protocol smallint check(allocation_protocol=1),
      add column creation_not_after timestamptz,
      add column creation_spec jsonb check(creation_spec is null or jsonb_typeof(creation_spec)='object'),
      add column allocation_closed boolean not null default false;
    alter table workspace_runtimes alter column allocation_protocol set default 1;
    alter table development_environments
      add column allocation_protocol smallint check(allocation_protocol=1),
      add column creation_not_after timestamptz,
      add column creation_spec jsonb check(creation_spec is null or jsonb_typeof(creation_spec)='object'),
      add column allocation_closed boolean not null default false;
    alter table development_environments alter column allocation_protocol set default 1;
    alter table workspace_terminal_sessions
      add column allocation_protocol smallint check(allocation_protocol=1),
      add column creation_not_after timestamptz,
      add column creation_spec jsonb check(creation_spec is null or jsonb_typeof(creation_spec)='object'),
      add column allocation_closed boolean not null default false;
    alter table workspace_terminal_sessions alter column allocation_protocol set default 1;
    update workspace_runtimes set allocation_protocol=1 where state='reserved';
    update development_environments set allocation_protocol=1 where state='requested';
    update workspace_terminal_sessions set allocation_protocol=1 where state='reserved';
    create function pi_cloud_allocation_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and (
        NEW.allocation_protocol is distinct from OLD.allocation_protocol or
        (OLD.creation_not_after is not null and NEW.creation_not_after is distinct from OLD.creation_not_after) or
        (OLD.creation_spec is not null and NEW.creation_spec is distinct from OLD.creation_spec) or
        (OLD.allocation_closed and not NEW.allocation_closed)
      ) then raise exception 'Allocation authorization cannot change or reopen'; end if;
      if (NEW.creation_spec is null) <> (NEW.creation_not_after is null) or
        (NEW.creation_spec is not null and NEW.allocation_protocol is distinct from 1)
      then raise exception 'Incomplete allocation authorization'; end if;
      return NEW;
    end $$;
    create trigger allocation_identity before insert or update of allocation_protocol,creation_not_after,creation_spec,allocation_closed
      on workspace_runtimes for each row execute function pi_cloud_allocation_identity();
    create trigger allocation_identity before insert or update of allocation_protocol,creation_not_after,creation_spec,allocation_closed
      on development_environments for each row execute function pi_cloud_allocation_identity();
    create trigger allocation_identity before insert or update of allocation_protocol,creation_not_after,creation_spec,allocation_closed
      on workspace_terminal_sessions for each row execute function pi_cloud_allocation_identity();
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error(
    "Restore matched drained Cube, application and database state before allocation rollback",
  );
}
