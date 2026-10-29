import { sql, type Kysely } from "kysely";

/** Matched, drained conversion. Immutable history outlives its original writer;
 * neither retained records nor directory roots authorize opening that writer. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table pi_sessions,session_leases,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_durable_current where replay_offset is not null)
      then raise exception 'Drain writers and project native handoffs before shared history conversion'; end if;
      if exists(select 1 from sessions where not history_imported)
      then raise exception 'Finish the schema-203 independent-history conversion before this matched upgrade'; end if;
    end $$;
    alter table pi_sessions add column history_bootstrap_pending boolean not null default true;
    alter table pi_sessions alter column history_bootstrap_pending set default false;
    create table pi_history_streams (
      tenant_id uuid not null references tenants(id) on delete cascade,
      id text not null,pending_gc boolean not null default true, primary key(tenant_id,id)
    );
    insert into pi_history_streams select distinct tenant_id,session_id from pi_durable_writes;
    alter table pi_durable_writes rename to pi_history_records;
    alter table pi_history_records drop constraint pi_durable_log_tenant_id_session_id_seq_fkey;
    alter table pi_history_records add column id uuid not null default gen_random_uuid(),
      add column committed_at timestamptz,
      add column assets_indexed boolean not null default false,
      add column fields jsonb not null default '{}',
      add constraint pi_history_record_identity unique(tenant_id,id),
      add foreign key(tenant_id) references tenants(id) on delete cascade,
      add foreign key(tenant_id,session_id) references pi_history_streams(tenant_id,id);
    update pi_history_records g set committed_at=c.committed_at from pi_durable_commits c
      where c.tenant_id=g.tenant_id and c.session_id=g.session_id and c.seq=g.seq;
    alter table pi_history_records alter column committed_at set not null;
    update pi_history_records w set fields=r.fields from pi_durable_records r
      where r.tenant_id=w.tenant_id and r.session_id=w.session_id and r.id=w.record_id
        and w.record_kind='entry';
    create index pi_history_entry_range on pi_history_records(tenant_id,session_id,entry_conversation_id,record_id,seq)
      where record_kind='entry';
    create index pi_history_entry_head on pi_history_records(tenant_id,session_id,entry_conversation_id,record_id desc)
      where record_kind='entry' and fields ? 'head';
    create table pi_durable_write_refs (
      tenant_id uuid not null,session_id text not null,seq bigint not null,ordinal int not null,
      retained_record_id uuid not null,base boolean not null default false,clear_owner boolean not null default false,
      commit_seq bigint generated always as(case when base then null else seq end) stored,
      primary key(tenant_id,session_id,seq,ordinal),
      foreign key(tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,session_id,commit_seq) references pi_durable_commits(tenant_id,session_id,seq) on delete cascade,
      foreign key(tenant_id,retained_record_id) references pi_history_records(tenant_id,id)
    );
    create index pi_durable_retained_record on pi_durable_write_refs(tenant_id,retained_record_id);
    insert into pi_durable_write_refs(tenant_id,session_id,seq,ordinal,retained_record_id)
      select tenant_id,session_id,seq,ordinal,id from pi_history_records;
    create table pi_history_nodes (
      tenant_id uuid not null references tenants(id) on delete cascade,id uuid not null,
      left_id uuid,right_id uuid,source_id text,conversation_id bigint,through_seq bigint,clear_task boolean,retained_tasks bigint[],
      min_id bigint not null,max_id bigint not null,item_count bigint not null,height int not null,
      digest text not null,node jsonb not null,
      primary key(tenant_id,id),
      foreign key(tenant_id,left_id) references pi_history_nodes(tenant_id,id),
      foreign key(tenant_id,right_id) references pi_history_nodes(tenant_id,id),
      foreign key(tenant_id,source_id) references pi_history_streams(tenant_id,id),
      check(min_id>=2 and max_id>=min_id and item_count>0 and height>0),
      check((source_id is not null and conversation_id is not null and through_seq>0 and clear_task is not null
          and left_id is null and right_id is null and height=1)
        or(source_id is null and conversation_id is null and through_seq is null and clear_task is null
          and left_id is not null and right_id is not null and height>1))
    );
    create index pi_history_node_left on pi_history_nodes(tenant_id,left_id) where left_id is not null;
    create index pi_history_node_right on pi_history_nodes(tenant_id,right_id) where right_id is not null;
    create index pi_history_node_range on pi_history_nodes(tenant_id,source_id,conversation_id,min_id,max_id,through_seq) where source_id is not null;
    create table pi_durable_bases (
      tenant_id uuid not null,session_id text not null,through_seq bigint not null,next_id bigint not null,
      entry_root uuid,entry_digest text,history_count bigint not null,history_fingerprint text not null,
      current_hashes jsonb not null default '{}',
      primary key(tenant_id,session_id),
      foreign key(tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,entry_root) references pi_history_nodes(tenant_id,id),
      check(through_seq>=0 and next_id>=2 and history_count>=0)
    );
    create index pi_durable_base_root on pi_durable_bases(tenant_id,entry_root) where entry_root is not null;
    create function pi_history_ranges(owner_tenant uuid,root_id uuid) returns setof pi_history_nodes
      language sql stable as $$
        with recursive walk as (
          select n.* from pi_history_nodes n where n.tenant_id=owner_tenant and n.id=root_id
          union all
          select c.* from walk p cross join lateral(values(p.left_id),(p.right_id)) edge(id)
            join pi_history_nodes c on c.tenant_id=owner_tenant and c.id=edge.id
        ) select * from walk where source_id is not null
      $$;
    create view pi_durable_inherited_entries as
      select b.tenant_id,b.session_id,g.seq,g.ordinal,g.record_id,g.entry_body_id,g.entry_conversation_id,
        case when (n.clear_task or (n.retained_tasks is not null and not coalesce(g.entry_task_id=any(n.retained_tasks),false))) then null::bigint else g.entry_task_id end as entry_task_id,
        case when (n.clear_task or (n.retained_tasks is not null and not coalesce(g.entry_task_id=any(n.retained_tasks),false))) then g.fields-'task' else g.fields end as fields,
        g.cloud_origin,g.id as retained_record_id,g.committed_at,(n.clear_task or (n.retained_tasks is not null and not coalesce(g.entry_task_id=any(n.retained_tasks),false))) as clear_task
      from pi_durable_bases b cross join lateral pi_history_ranges(b.tenant_id,b.entry_root) n
      join pi_history_records g on g.tenant_id=b.tenant_id and g.session_id=n.source_id and g.record_kind='entry'
        and g.entry_conversation_id=n.conversation_id and g.record_id between n.min_id and n.max_id and g.seq<=n.through_seq;
    create view pi_durable_writes as
      select r.tenant_id,r.session_id,r.seq,r.ordinal,g.record_kind,g.record_id,
        case when r.clear_owner and g.record_kind='conversation' then
          jsonb_set(g.body::jsonb,'{value}',(g.body::jsonb->'value')-'owner')::text else g.body end as body,
        g.phase,g.cloud_origin,g.entry_body_id,g.entry_conversation_id,g.entry_task_id,g.id as retained_record_id,g.committed_at
      from pi_durable_write_refs r join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
      union all select tenant_id,session_id,seq,ordinal,'entry',record_id,null::text,null::text,cloud_origin,
        entry_body_id,entry_conversation_id,entry_task_id,retained_record_id,committed_at from pi_durable_inherited_entries;
    create or replace view pi_durable_log as
      select l.tenant_id,l.session_id,l.seq,l.ordinal,l.record_kind,l.record_id,
        case when l.record_kind='entry' then concat(pi_native_entry_prefix(l.record_id,l.entry_conversation_id,l.entry_task_id),substr(b.payload_text,2),'}') else l.body end as body,
        l.phase,l.cloud_origin,
        case when l.record_kind='entry' then b.payload_bytes+octet_length(pi_native_entry_prefix(l.record_id,l.entry_conversation_id,l.entry_task_id)) else octet_length(l.body) end::bigint as body_bytes,
        l.entry_body_id,l.retained_record_id,l.committed_at
      from pi_durable_writes l left join pi_history_bodies b on b.tenant_id=l.tenant_id and b.id=l.entry_body_id;
    alter table pi_durable_records rename to pi_durable_owned_records;
    alter table pi_durable_owned_records drop constraint pi_durable_records_tenant_id_session_id_seq_fkey;
    alter table pi_durable_owned_records add foreign key(tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade;
    alter table pi_durable_owned_records add column retained_record_id uuid,add column body_fork boolean not null default false;
    update pi_durable_owned_records r set retained_record_id=w.retained_record_id
      from pi_durable_write_refs w where w.tenant_id=r.tenant_id and w.session_id=r.session_id and (w.seq,w.ordinal)=(r.seq,r.ordinal);
    create view pi_durable_records as
      select * from pi_durable_owned_records
      union all select e.tenant_id,e.session_id,e.record_id,'entry',e.seq,e.ordinal,e.fields,null::bigint,null::bigint,e.retained_record_id,e.clear_task
        from pi_durable_inherited_entries e where not exists(select 1 from pi_durable_owned_records o
          where o.tenant_id=e.tenant_id and o.session_id=e.session_id and o.id=e.record_id);
    do $$ declare name text; begin
      select conname into strict name from pg_constraint where contype='f'
        and conrelid='pi_durable_document_revisions'::regclass and confrelid='pi_history_records'::regclass;
      execute format('alter table pi_durable_document_revisions drop constraint %I',name);
    end $$;
    alter table pi_durable_document_revisions add foreign key(tenant_id,session_id,seq,ordinal)
      references pi_durable_write_refs(tenant_id,session_id,seq,ordinal) on delete cascade;
    alter table pi_durable_current drop constraint pi_durable_current_tenant_id_session_id_seq_fkey;
    alter table pi_durable_current add column base_state boolean not null default false,
      add column committed_at timestamptz,
      add column commit_seq bigint generated always as(case when base_state then null else seq end) stored,
      add foreign key(tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade,
      add foreign key(tenant_id,session_id,commit_seq) references pi_durable_commits(tenant_id,session_id,seq) on delete cascade;
    update pi_durable_current s set committed_at=c.committed_at from pi_durable_commits c
      where c.tenant_id=s.tenant_id and c.session_id=s.session_id and c.seq=s.seq;
    alter table pi_durable_current alter column committed_at set not null;
    create table pi_history_record_images (
      tenant_id uuid not null,retained_record_id uuid not null,image_id uuid not null,
      primary key(tenant_id,retained_record_id,image_id),
      foreign key(tenant_id,retained_record_id) references pi_history_records(tenant_id,id) on delete cascade,
      foreign key(tenant_id,image_id) references session_image_objects(tenant_id,id)
    );
    create index pi_history_record_image on pi_history_record_images(tenant_id,image_id);
    create index pi_history_pending_gc on pi_history_streams(tenant_id,id) where pending_gc;
    create function pi_retire_history_owner() returns trigger language plpgsql as $$ begin
      update pi_history_streams set pending_gc=true where tenant_id=old.tenant_id and (
        id=old.id or id in(select distinct g.session_id from pi_durable_write_refs r
          join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
          where r.tenant_id=old.tenant_id and r.session_id=old.id));
      return old;
    end $$;
    create trigger pi_retire_history_owner before delete on pi_sessions for each row execute function pi_retire_history_owner();
    create table pi_history_blocks (
      tenant_id uuid not null references tenants(id) on delete cascade,id uuid not null default gen_random_uuid(),
      source_session_id uuid not null,source_pi_session_id text not null,owner_pi_session_id text,
      turn_id uuid not null,origin_session_id uuid not null,position bigint not null,
      header_body_id uuid,fields jsonb not null default '{}',pending_gc boolean not null default true,
      assets_indexed boolean not null default false,
      bootstrap_pending boolean not null default true,
      primary key(tenant_id,id),unique(tenant_id,source_pi_session_id,turn_id),
      foreign key(tenant_id,owner_pi_session_id) references pi_sessions(tenant_id,id) on delete set null(owner_pi_session_id),
      foreign key(tenant_id,header_body_id) references pi_history_bodies(tenant_id,id),
      check(position>0)
    );
    create index pi_history_block_turn on pi_history_blocks(tenant_id,turn_id);
    create index pi_history_block_gc on pi_history_blocks(tenant_id,id) where pending_gc;
    create function pi_history_block_owner_retired() returns trigger language plpgsql as $$ begin
      new.pending_gc=true; return new;
    end $$;
    create trigger pi_history_block_owner_retired before update of owner_pi_session_id on pi_history_blocks
      for each row when(new.owner_pi_session_id is distinct from old.owner_pi_session_id) execute function pi_history_block_owner_retired();
    create table pi_history_frames (
      tenant_id uuid not null,block_id uuid not null,seq bigint not null,ordinal int not null,
      record_id bigint not null,entry_id bigint,entry_record_id uuid,assistant_id bigint,assistant_record_id uuid,
      body_id uuid not null,body_bytes bigint not null,fields jsonb not null default '{}',
      primary key(tenant_id,block_id,seq,ordinal),
      foreign key(tenant_id,block_id) references pi_history_blocks(tenant_id,id) on delete cascade,
      foreign key(tenant_id,entry_record_id) references pi_history_records(tenant_id,id),
      foreign key(tenant_id,assistant_record_id) references pi_history_records(tenant_id,id),
      foreign key(tenant_id,body_id) references pi_history_bodies(tenant_id,id),
      check((entry_id is null)=(entry_record_id is null))
    );
    create index pi_history_frame_entry on pi_history_frames(tenant_id,block_id,entry_id) where entry_id is not null;
    create index pi_history_frame_body on pi_history_frames(tenant_id,body_id);
    create index pi_history_frame_record on pi_history_frames(tenant_id,entry_record_id) where entry_record_id is not null;
    create index pi_history_frame_assistant on pi_history_frames(tenant_id,assistant_record_id) where assistant_record_id is not null;
    create table pi_history_header_images (
      tenant_id uuid not null,body_id uuid not null,image_id uuid not null,
      primary key(tenant_id,body_id,image_id),
      foreign key(tenant_id,body_id) references pi_history_bodies(tenant_id,id) on delete cascade,
      foreign key(tenant_id,image_id) references session_image_objects(tenant_id,id)
    );
    create index pi_history_header_image on pi_history_header_images(tenant_id,image_id);
    create table pi_history_view_nodes (
      tenant_id uuid not null references tenants(id) on delete cascade,id uuid not null,
      left_id uuid,right_id uuid,block_id uuid,header_body_id uuid,header_fields jsonb,through_seq bigint,through_ordinal int,
      min_position bigint not null,max_position bigint not null,turn_count bigint not null,height int not null,node jsonb not null,
      primary key(tenant_id,id),
      foreign key(tenant_id,left_id) references pi_history_view_nodes(tenant_id,id),
      foreign key(tenant_id,right_id) references pi_history_view_nodes(tenant_id,id),
      foreign key(tenant_id,block_id) references pi_history_blocks(tenant_id,id),
      foreign key(tenant_id,header_body_id) references pi_history_bodies(tenant_id,id),
      check(min_position>0 and max_position>=min_position and turn_count>0 and height>0),
      check((block_id is not null and left_id is null and right_id is null and height=1 and turn_count=1
          and min_position=max_position and through_seq is not null and through_ordinal is not null)
        or(block_id is null and left_id is not null and right_id is not null and height>1 and through_seq is null and through_ordinal is null))
    );
    create index pi_history_view_left on pi_history_view_nodes(tenant_id,left_id) where left_id is not null;
    create index pi_history_view_right on pi_history_view_nodes(tenant_id,right_id) where right_id is not null;
    create index pi_history_view_block on pi_history_view_nodes(tenant_id,block_id,through_seq,through_ordinal) where block_id is not null;
    create table pi_history_views (
      tenant_id uuid not null,session_id uuid not null,root_id uuid not null,
      primary key(tenant_id,session_id),
      foreign key(tenant_id,session_id) references sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,root_id) references pi_history_view_nodes(tenant_id,id)
    );
    create index pi_history_view_root on pi_history_views(tenant_id,root_id);
    create index pi_history_view_header on pi_history_view_nodes(tenant_id,header_body_id,min_position) where header_body_id is not null;
    create function pi_history_view_ranges(owner_tenant uuid,root_id uuid,minimum bigint default 1,maximum bigint default 9223372036854775807)
      returns setof pi_history_view_nodes language sql stable as $$
        with recursive walk as (
          select n.* from pi_history_view_nodes n where n.tenant_id=owner_tenant and n.id=root_id
            and n.max_position>=minimum and n.min_position<=maximum
          union all select c.* from walk p cross join lateral(values(p.left_id),(p.right_id)) edge(id)
            join pi_history_view_nodes c on c.tenant_id=owner_tenant and c.id=edge.id
            where c.max_position>=minimum and c.min_position<=maximum
        ) select * from walk where block_id is not null
      $$;
    insert into pi_history_blocks(tenant_id,source_session_id,source_pi_session_id,owner_pi_session_id,turn_id,origin_session_id,position,header_body_id,fields)
      select h.tenant_id,h.session_id,s.pi_session_id,s.pi_session_id,h.turn_id,h.origin_session_id,h.position,h.body_id,h.fields
      from pi_history_snapshots h join sessions s on s.tenant_id=h.tenant_id and s.id=h.session_id where h.kind='turn';
    insert into pi_history_frames(tenant_id,block_id,seq,ordinal,record_id,entry_id,entry_record_id,assistant_id,assistant_record_id,body_id,body_bytes,fields)
      select h.tenant_id,b.id,h.seq,h.ordinal,h.record_id,h.entry_id,r.retained_record_id,h.assistant_id,a.retained_record_id,h.body_id,h.body_bytes,h.fields
      from pi_history_snapshots h join sessions s on s.tenant_id=h.tenant_id and s.id=h.session_id
      join pi_history_blocks b on b.tenant_id=h.tenant_id and b.source_pi_session_id=s.pi_session_id and b.turn_id=h.turn_id
      left join pi_durable_records r on r.tenant_id=h.tenant_id and r.session_id=s.pi_session_id and r.id=h.entry_id and r.kind='entry'
      left join pi_durable_records a on a.tenant_id=h.tenant_id and a.session_id=s.pi_session_id and a.id=h.assistant_id and a.kind='entry'
      where h.kind='record';
    drop view pi_history_turns;
    drop table pi_history_snapshots;
    create view pi_history_visible_blocks as
      select v.tenant_id,v.session_id,n.block_id,n.through_seq,n.through_ordinal,n.min_position as position,n.header_body_id,n.header_fields
      from pi_history_views v cross join lateral pi_history_view_ranges(v.tenant_id,v.root_id) n;
    create view pi_history_snapshots as
      select v.tenant_id,v.session_id,b.turn_id,b.origin_session_id,'turn'::text as kind,0::bigint as record_id,
        0::bigint as seq,0::int as ordinal,v.position,null::bigint as entry_id,null::bigint as assistant_id,
        v.header_body_id as body_id,v.header_fields as fields,h.payload_bytes as body_bytes,null::uuid as entry_record_id,null::uuid as assistant_record_id
      from pi_history_visible_blocks v join pi_history_blocks b on b.tenant_id=v.tenant_id and b.id=v.block_id
      join pi_history_bodies h on h.tenant_id=b.tenant_id and h.id=v.header_body_id
      union all
      select v.tenant_id,v.session_id,b.turn_id,b.origin_session_id,'record',f.record_id,f.seq,f.ordinal,v.position,
        f.entry_id,f.assistant_id,f.body_id,f.fields,f.body_bytes,f.entry_record_id,f.assistant_record_id
      from pi_history_visible_blocks v join pi_history_blocks b on b.tenant_id=v.tenant_id and b.id=v.block_id
      join pi_history_frames f on f.tenant_id=v.tenant_id and f.block_id=v.block_id and (f.seq,f.ordinal)<=(v.through_seq,v.through_ordinal);
    create view pi_history_live_turns as
      select r.tenant_id,r.session_id,r.session_id as origin_session_id,r.turn_id,r.id as run_id,
        s.pi_session_id,r.mailbox_position,r.operation_kind,r.state,r.stop_reason,r.output_display_seq,r.output_display_native_seq,
        (r.output_seal_id is not null and r.output_sealed_at is null) as waiting_for_seal,r.created_at,false as frozen
      from conversation_turns r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
      left join lateral (
        select n.*,b.source_session_id,b.source_pi_session_id from pi_history_views v
        cross join lateral pi_history_view_ranges(v.tenant_id,v.root_id,r.mailbox_position,r.mailbox_position) n
        join pi_history_blocks b on b.tenant_id=v.tenant_id and b.id=n.block_id
        where v.tenant_id=r.tenant_id and v.session_id=r.session_id and b.turn_id=r.turn_id limit 1
      ) snapshot on true
      where r.pruned_at is null and s.pruned_at is null and (r.state<>'queued' or r.operation_kind='compact')
        and not(r.operation_kind='chat' and r.state='cancelled' and r.started_at is null)
        and (snapshot.block_id is null or (snapshot.source_session_id=r.session_id and snapshot.source_pi_session_id=s.pi_session_id and (
          r.state not in ('completed','failed','cancelled','timed_out')
          or r.state is distinct from snapshot.header_fields->>'runState'
          or r.output_display_seq<>(snapshot.header_fields->>'coverage')::bigint
          or r.output_display_native_seq<>(snapshot.header_fields->>'nativeCoverage')::bigint
          or exists(select 1 from pi_history_frames f where f.tenant_id=r.tenant_id and f.block_id=snapshot.block_id
            and (f.seq,f.ordinal)>(snapshot.through_seq,snapshot.through_ordinal)))));
    create view pi_history_turns as
      select * from pi_history_live_turns
      union all
      select h.tenant_id,h.session_id,h.origin_session_id,h.turn_id,(h.fields->>'runId')::uuid,s.pi_session_id,h.position,
        h.fields->>'operationKind',h.fields->>'runState',h.fields->>'stopReason',
        (h.fields->>'coverage')::bigint,(h.fields->>'nativeCoverage')::bigint,false,(h.fields->>'acceptedAt')::timestamptz,true
      from pi_history_snapshots h join sessions s on s.tenant_id=h.tenant_id and s.id=h.session_id where h.kind='turn' and s.pruned_at is null
        and not exists(select 1 from pi_history_live_turns live where live.tenant_id=h.tenant_id and live.session_id=h.session_id and live.turn_id=h.turn_id);
    alter table pi_history_records alter column assets_indexed set default true;
    alter table pi_history_blocks alter column assets_indexed set default true;
    alter table pi_history_blocks alter column bootstrap_pending set default false;
    alter table sessions drop column history_imported;
  `.execute(database);
  const definition = (
    await sql<{
      definition: string;
    }>`select pg_get_viewdef('subagent_executions'::regclass,true) as definition`.execute(database)
  ).rows[0]!.definition;
  const join = /JOIN pi_durable_commits c USING \(tenant_id, session_id, seq\)/g;
  if ([...definition.matchAll(join)].length !== 1)
    throw new Error("Unexpected native child projection definition");
  await sql
    .raw(
      `create or replace view subagent_executions as ${definition
        .replaceAll("pi_durable_owned_records", "pi_durable_records")
        .replace(
          join,
          "LEFT JOIN pi_history_records history ON history.tenant_id=r.tenant_id AND history.id=r.retained_record_id LEFT JOIN pi_durable_current current_state ON current_state.tenant_id=r.tenant_id AND current_state.session_id=r.session_id AND current_state.id=r.id",
        )
        .replaceAll(
          "c.committed_at",
          "COALESCE(history.committed_at,current_state.committed_at)",
        )}`,
    )
    .execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Shared history bases require a drained matched schema/runtime transition");
}
