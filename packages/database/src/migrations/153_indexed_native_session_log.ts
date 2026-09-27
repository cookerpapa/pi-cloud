import { sql, type Kysely } from "kysely";

/** ADR-0197. Applications must be quiescent during this single-layout cutover. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from pi_sessions where unsealed_runs<>0) then
        raise exception 'Native Sessions must settle before indexed-log cutover';
      end if;
    end $$;
    alter table pi_session_log
      add column id text generated always as (payload -> kind ->> 'id') stored,
      add column type text generated always as (payload -> kind ->> 'type') stored,
      add column parent_id text generated always as (payload #>> '{entry,parentId}') stored,
      add column custom_type text generated always as (payload #>> '{entry,customType}') stored,
      add column lane text generated always as (
        case when kind='entry' then payload->>'lane' else payload #>> '{record,lane}' end
      ) stored,
      add column run_id text generated always as (
        case when payload #>> '{record,type}'='operation_started'
          then payload #>> '{record,id}' else payload #>> '{record,runId}' end
      ) stored,
      add column operation_kind text generated always as (payload #>> '{record,intent,kind}') stored,
      add column timestamp_ms bigint generated always as ((payload -> kind ->> 'timestamp')::bigint) stored,
      add column turn_id uuid;

    update pi_session_log log set turn_id=owner.id from turns owner
      where owner.id=(log.payload->>'turnId')::uuid and owner.tenant_id=log.tenant_id;
    with bindings as (
      select tenant_id,session_id,seq,turn_id from pi_session_entries
      union all select tenant_id,session_id,seq,turn_id from pi_session_records
      union all
      select ref.tenant_id,ref.session_id,ref.seq,source.turn_id
        from pi_session_entry_refs ref join pi_session_entries source
          on source.tenant_id=ref.tenant_id and source.session_id=ref.source_session_id
         and source.id=ref.source_entry_id
    )
    -- SDK Fork logs intentionally have no Turn binding even though their old
    -- COW reference points at an Entry owned by a product Turn.
    update pi_session_log log set turn_id=case when log.payload->>'turnId' is null then null else binding.turn_id end
      from bindings binding
      where log.tenant_id=binding.tenant_id and log.session_id=binding.session_id and log.seq=binding.seq;

    alter table pi_session_log add constraint pi_session_log_turn_fk
      foreign key(turn_id) references turns(id) on delete set null;
    alter table pi_session_log add constraint pi_session_log_turn_matches_origin check (
      turn_id is null or turn_id is not distinct from (payload->>'turnId')::uuid
    );
    alter table pi_session_log add constraint pi_session_log_native_fields_valid check (
      kind not in ('entry','record') or
      (id is not null and length(id)>0 and type is not null and timestamp_ms is not null
       and timestamp_ms>=0 and payload -> kind ->> 'seq' is not null
       and (payload -> kind ->> 'seq')::bigint=seq)
    );
    create unique index pi_session_log_id on pi_session_log(tenant_id,session_id,id) where id is not null;
    create index pi_session_log_entry_seq on pi_session_log(tenant_id,session_id,seq) where kind='entry';
    create index pi_session_log_entry_type on pi_session_log(tenant_id,session_id,type,seq) where kind='entry';
    create index pi_session_log_entry_parent on pi_session_log(tenant_id,session_id,parent_id) where kind='entry';
    create index pi_session_log_record_seq on pi_session_log(tenant_id,session_id,seq) where kind='record';
    create index pi_session_log_record_query on pi_session_log(tenant_id,session_id,lane,type,run_id,seq)
      where kind='record';
    create index pi_session_log_turn on pi_session_log(tenant_id,turn_id,kind,seq) where turn_id is not null;
    create index pi_session_log_turn_message on pi_session_log(tenant_id,turn_id,seq desc)
      where kind='entry' and type='message' and turn_id is not null;

    create function bind_native_session_turn() returns trigger language plpgsql as $$
    begin
      new.turn_id := (new.payload->>'turnId')::uuid;
      return new;
    end $$;
    create trigger bind_native_session_turn before insert on pi_session_log
      for each row execute function bind_native_session_turn();

    create table pi_session_open_operations (
      tenant_id uuid not null,
      session_id text not null,
      lane text not null,
      seq bigint not null,
      primary key(tenant_id,session_id,lane,seq),
      foreign key(tenant_id,session_id,seq) references pi_session_log(tenant_id,session_id,seq) on delete cascade
    );
    insert into pi_session_open_operations(tenant_id,session_id,lane,seq)
      select started.tenant_id,started.session_id,started.lane,started.seq
        from pi_session_log started
       where started.kind='record' and started.type='operation_started'
         and not exists(select 1 from pi_session_log finished
           where finished.tenant_id=started.tenant_id and finished.session_id=started.session_id
             and finished.kind='record' and finished.type='operation_finished'
             and finished.lane=started.lane and finished.run_id=started.id and finished.seq>started.seq);

    create function track_native_session_open_operations() returns trigger language plpgsql as $$
    declare finished record;
    begin
      if not exists(select 1 from appended where kind='record' and type in ('operation_started','operation_finished')) then
        return null;
      end if;
      insert into pi_session_open_operations(tenant_id,session_id,lane,seq)
        select tenant_id,session_id,lane,seq from appended
         where kind='record' and type='operation_started';
      -- The transition table has no indexes and its batch size varies. Avoid
      -- a cached many-to-many join against all current operations: each finish
      -- resolves one immutable ID, then deletes one fully scoped primary key.
      for finished in select tenant_id,session_id,lane,run_id,seq from appended
        where kind='record' and type='operation_finished'
      loop
        delete from pi_session_open_operations open
          where open.tenant_id=finished.tenant_id and open.session_id=finished.session_id
            and open.lane=finished.lane and open.seq=(
              select started.seq from pi_session_log started
               where started.tenant_id=finished.tenant_id and started.session_id=finished.session_id
                 and started.id=finished.run_id and started.kind='record' and started.type='operation_started'
                 and started.seq<finished.seq);
      end loop;
      return null;
    end $$;
    create trigger track_native_session_open_operations after insert on pi_session_log
      referencing new table as appended for each statement execute function track_native_session_open_operations();

    drop view pi_session_visible_entries;
    drop table pi_session_entry_refs;
    drop table pi_session_entries;
    drop table pi_session_records;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore the prior database snapshot with matching applications; indexed-log rollback is not supported",
  );
}
