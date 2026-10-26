import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`lock table runs,sessions,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before execution target cutover'; end if;
    end $$;
    create table execution_targets (
      id uuid primary key,tenant_id uuid not null references tenants(id),
      kind text not null check(kind='android'),name text not null,
      endpoint text not null,capabilities jsonb not null check(jsonb_typeof(capabilities)='array'),
      revision bigint not null default 1 check(revision>0),
      admission_generation bigint not null default 0 check(admission_generation>=0),
      bound_session_id uuid, enabled boolean not null default true,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      unique(tenant_id,id),unique(tenant_id,bound_session_id,kind),
      foreign key(tenant_id,bound_session_id) references sessions(tenant_id,id)
    );
    alter table runs add column execution_target_snapshot jsonb not null default '[]'::jsonb check(jsonb_typeof(execution_target_snapshot)='array');
    create table execution_target_bindings (
      id uuid primary key,tenant_id uuid not null,target_id uuid not null,
      run_id uuid not null references runs(id),
      session_id uuid not null,pi_session_id text not null,
      writer_id uuid not null, fencing_token bigint not null,
      conversation_id bigint not null, target_revision bigint not null, admission_generation bigint not null,
      executor_boot_id uuid not null,endpoint text not null,capabilities jsonb not null,
      closed boolean not null default false,revision bigint not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      foreign key(tenant_id,session_id) references sessions(tenant_id,id),
      foreign key(tenant_id,target_id) references execution_targets(tenant_id,id),
      unique(tenant_id,run_id,writer_id,target_id)
    );
    create index execution_binding_writer on execution_target_bindings(tenant_id,pi_session_id,writer_id) where not closed;
    create function publish_execution_binding_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if not OLD.closed then raise exception 'Close executor admission before removing binding'; end if;
        if exists(select 1 from tenants where id=OLD.tenant_id) then
          perform pi_cloud_control_change(OLD.tenant_id,OLD.pi_session_id,'execution_binding',OLD.id,nextval('session_control_change_version'),
            jsonb_build_object('runId',OLD.run_id,'closed',true));
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'closed'-'revision')<>(to_jsonb(OLD)-'closed'-'revision') or (OLD.closed and not NEW.closed)
          then raise exception 'Executor binding identity cannot change or reopen'; end if;
        if NEW.closed=OLD.closed then return NEW; end if;
      end if;
      NEW.revision:=nextval('session_control_change_version');
      perform pi_cloud_control_change(NEW.tenant_id,NEW.pi_session_id,'execution_binding',NEW.id,NEW.revision,
        jsonb_build_object('runId',NEW.run_id,'closed',NEW.closed));
      return new;
    end $$;
    create trigger execution_binding_change before insert or update or delete on execution_target_bindings
      for each row execute function publish_execution_binding_change();
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Use a drained matched execution-target release");
}
