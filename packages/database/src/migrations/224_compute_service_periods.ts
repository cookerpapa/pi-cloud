import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table session_leases,workspace_runtimes,workspace_terminal_sessions,development_environments in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before service-accounting cutover'; end if;
    end $$;
    drop table resource_lifecycle_sources;
    alter table resource_metering_resources drop column lifecycle_state;
    alter table resource_metering_resources alter column workspace_id drop not null;
    alter table resource_metering_events alter column workspace_id drop not null;
    alter table resource_metering_resources add check(kind<>'workspace' or workspace_id is not null);
    alter table resource_metering_events add check(resource_kind<>'workspace' or workspace_id is not null);
    alter table resource_metering_resources
      add column service_contract jsonb check(service_contract is null or octet_length(service_contract::text)<=4096),
      add column reclamation jsonb check(reclamation is null or octet_length(reclamation::text)<=4096);
    alter table execution_targets add column compute_service jsonb
      check(compute_service is null or (kind='android' and jsonb_typeof(compute_service)='object' and octet_length(compute_service::text)<=4096));
    update sandbox_domains set backend_catalog=jsonb_set(backend_catalog,'{computeBilling}','"platform"')
      where backend_catalog is not null;
    create table compute_service_periods (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      resource_key text not null references resource_metering_resources(id),
      opened_at timestamptz not null,
      observed_at timestamptz not null,
      cutoff_at timestamptz,
      ended_at timestamptz,
      end_reason text,
      settled_through timestamptz not null,
      needs_settlement boolean not null default false,
      updated_at timestamptz not null default clock_timestamp(),
      check(observed_at>=opened_at),
      check(ended_at is null or ended_at>=opened_at),
      check(settled_through>=opened_at)
    );
    create unique index compute_service_one_open_period on compute_service_periods(resource_key) where ended_at is null;
    create index compute_service_settlement_due on compute_service_periods(updated_at,id) where needs_settlement;
    create index compute_service_resource_periods on compute_service_periods(resource_key,opened_at);
    create index managed_device_compute_services on execution_targets(id) where compute_service is not null;

    create function pi_cloud_compute_service_state(k text,available boolean,at_time timestamptz,why text default null,cutoff timestamptz default null) returns void language plpgsql as $$
    declare r resource_metering_resources; p compute_service_periods; ending timestamptz; previous_end timestamptz;
    begin
      select * into r from resource_metering_resources where id=k for update;
      if not found or r.service_contract->>'billing'<>'platform' or r.service_contract->'quantity' is null
        or r.service_contract->'quantity'='null'::jsonb then return; end if;
      if at_time<(r.service_contract->>'acceptedAt')::timestamptz then return; end if;
      select * into p from compute_service_periods where resource_key=k and ended_at is null for update;
      if available then
        if p.id is not null then
          if at_time<=p.observed_at then return; end if;
          if at_time-p.observed_at<=interval '90 seconds' then
            update compute_service_periods set observed_at=at_time,
              needs_settlement=(at_time>=settled_through+interval '1 minute'),
              updated_at=clock_timestamp() where id=p.id;
            return;
          end if;
          update compute_service_periods set cutoff_at=observed_at,ended_at=observed_at,end_reason='observation_gap',
            needs_settlement=(observed_at>=settled_through+interval '1 minute'),
            updated_at=clock_timestamp() where id=p.id;
        end if;
        select max(ended_at) into previous_end from compute_service_periods where resource_key=k;
        if previous_end is not null and at_time<previous_end then return; end if;
        insert into compute_service_periods(tenant_id,resource_key,opened_at,observed_at,settled_through)
          values(r.tenant_id,k,at_time,at_time,at_time);
      elsif p.id is not null then
        if at_time<p.observed_at and coalesce(why,'unavailable')='unavailable' then return; end if;
        ending:=p.observed_at;
        if at_time<p.observed_at then why:='clock_changed';
        elsif why in ('pause','release','idle_expiry','reclaim') and coalesce(cutoff,at_time)-p.observed_at<=interval '90 seconds'
          then ending:=coalesce(cutoff,at_time); end if;
        ending:=greatest(p.opened_at,p.settled_through,case when why='clock_changed' then ending else least(ending,coalesce(cutoff,at_time)) end);
        update compute_service_periods set cutoff_at=coalesce(cutoff,at_time),ended_at=ending,end_reason=coalesce(why,'unavailable'),
          needs_settlement=(ending>=settled_through+interval '1 minute'),
          updated_at=clock_timestamp() where id=p.id;
      end if;
    end $$;

    create function pi_cloud_capture_compute_service() returns trigger language plpgsql as $$
    declare n jsonb; o jsonb; identifier text; old_identifier text; source_kind text:=TG_ARGV[0];
      ready_state text; active boolean; prior_active boolean; reason text; cutoff timestamptz;
    begin
      n:=case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
      o:=case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
      identifier:=coalesce(n->>TG_ARGV[1],o->>TG_ARGV[1]); old_identifier:=o->>TG_ARGV[1];
      if identifier is null then return coalesce(NEW,OLD); end if;
      ready_state:=case source_kind when 'development_environment' then 'ready' when 'terminal' then 'active' else 'allocated' end;
      active:=coalesce(n->>'state'=ready_state and not (n->>'allocation_closed')::boolean and coalesce(n->>'desired_state','running')='running',false);
      prior_active:=coalesce(o->>'state'=ready_state and not (o->>'allocation_closed')::boolean and coalesce(o->>'desired_state','running')='running',false);
      if old_identifier is not null and old_identifier<>identifier then
        perform pi_cloud_compute_service_state('compute:'||old_identifier,false,statement_timestamp(),'replaced'); prior_active:=false;
      end if;
      if active and not prior_active then
        perform pi_cloud_compute_service_state('compute:'||identifier,true,statement_timestamp(),'ready');
      elsif not active then
        reason:=case
          when n->>'failure_code'='runtime_idle_expired' then 'idle_expiry'
          when n->>'desired_state'='paused' or n->>'state'='paused' then 'pause'
          when n->>'desired_state'='released' or n->>'state'='released' then 'release'
          when n->>'state'='cleaning' then 'reclaim' else 'resource_unavailable' end;
        cutoff:=case when reason='idle_expiry' then coalesce((n->>'idle_expires_at')::timestamptz,(o->>'idle_expires_at')::timestamptz,statement_timestamp()) else statement_timestamp() end;
        perform pi_cloud_compute_service_state('compute:'||identifier,false,statement_timestamp(),reason,cutoff);
      end if;
      if (n->>'allocation_closed')::boolean and not coalesce((o->>'allocation_closed')::boolean,false) then
        update resource_metering_resources set reclamation=coalesce(reclamation,'{}'::jsonb)||jsonb_build_object(
          'requestedAt',coalesce(reclamation->>'requestedAt',statement_timestamp()::text),'reason',coalesce(reason,'reclaim'),
          'physicalStopOccurredAt',null) where id='compute:'||identifier;
      end if;
      return coalesce(NEW,OLD);
    end $$;
    create trigger compute_service_workspace after insert or update of state,allocation_closed or delete on workspace_runtimes
      for each row execute function pi_cloud_capture_compute_service('workspace','workspace_runtime_id');
    create trigger compute_service_terminal after insert or update of state,allocation_closed or delete on workspace_terminal_sessions
      for each row execute function pi_cloud_capture_compute_service('terminal','terminal_id');
    create trigger compute_service_machine after insert or update of state,desired_state,allocation_closed,allocation_id or delete on development_environments
      for each row execute function pi_cloud_capture_compute_service('development_environment','allocation_id');

    create function pi_cloud_close_device_service() returns trigger language plpgsql as $$
    begin
      if OLD.compute_service is not null and (TG_OP='DELETE' or NEW.compute_service is distinct from OLD.compute_service or not NEW.enabled) then
        perform pi_cloud_compute_service_state('compute:'||(OLD.compute_service->>'allocationId'),false,statement_timestamp(),'release');
      end if;
      return coalesce(NEW,OLD);
    end $$;
    create trigger compute_service_device_close after update of compute_service,enabled or delete on execution_targets
      for each row execute function pi_cloud_close_device_service();

    -- Adopt only current allocated identities. Their first fresh observation
    -- opens a forward-only service period; old observation history is untouched.
    update resource_metering_resources r set service_contract=jsonb_build_object(
      'billing',coalesce(d.backend_catalog->>'computeBilling','external'),'provider',split_part(r.provider_binding->>'sourceId',':',1),
      'sourceKind',a.kind,'sourceId',a.id,'quantity',r.provider_binding->'quantity','acceptedAt',clock_timestamp())
    from (
      select workspace_runtime_id as id,sandbox_domain_id as domain,'workspace' as kind from workspace_runtimes where state<>'released'
      union all select allocation_id,sandbox_domain_id,'development_environment' from development_environments where not allocation_absent
      union all select terminal_id,sandbox_domain_id,'terminal' from workspace_terminal_sessions where state<>'released'
    ) a join sandbox_domains d on d.id=a.domain
    where r.id='compute:'||a.id::text and r.kind='compute' and r.provider_binding->'quantity' is not null;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Use a drained matched service-accounting release");
}
