import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table session_image_objects (
      -- Keep cleanup inventory after tenant deletion; Session references cascade.
      tenant_id uuid not null,
      id uuid not null,
      source_run_id uuid,
      state text not null check (state in ('uploading','ready','deleting')),
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      byte_length bigint not null check (byte_length between 1 and 44040192),
      mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
      created_at timestamptz not null default clock_timestamp(),
      primary key (tenant_id,id)
    );
    create index session_image_objects_gc on session_image_objects(created_at);
    create table session_image_references (
      tenant_id uuid not null,
      session_id text not null,
      image_id uuid not null,
      primary key (tenant_id,session_id,image_id),
      foreign key (tenant_id,session_id) references pi_sessions(tenant_id,id) on delete cascade,
      foreign key (tenant_id,image_id) references session_image_objects(tenant_id,id)
    );
    create index session_image_references_object on session_image_references(tenant_id,image_id);
    create function native_session_image_references(node jsonb) returns setof jsonb
      language plpgsql immutable as $$
    declare child jsonb;
    begin
      if node->>'type'='pi_cloud_image_v1' then return next node->'attachment'; return; end if;
      if jsonb_typeof(node)='array' then
        for child in select value from jsonb_array_elements(node) loop
          return query select * from native_session_image_references(child);
        end loop;
      elsif jsonb_typeof(node)='object' then
        for child in select value from jsonb_each(node)
          where key not in ('details','arguments','effectiveArgs','data','resumeData') loop
          return query select * from native_session_image_references(child);
        end loop;
      end if;
    end $$;
    create function retain_native_session_images() returns trigger language plpgsql as $$
    declare image jsonb;
    begin
      if not jsonb_path_exists(new.payload,'$.** ? (@.type == "pi_cloud_image_v1")') then return new; end if;
      for image in select * from native_session_image_references(new.payload)
      loop
        perform 1 from session_image_objects o
          where o.tenant_id=new.tenant_id and o.id=(image->>'id')::uuid
            and o.state='ready' and o.sha256=image->>'sha256'
            and o.byte_length=(image->>'byteLength')::bigint
            and o.mime_type=image->>'mimeType' for share;
        if not found then raise exception 'Native image attachment is unavailable or mismatched'; end if;
        insert into session_image_references(tenant_id,session_id,image_id)
          values(new.tenant_id,new.session_id,(image->>'id')::uuid) on conflict do nothing;
      end loop;
      return new;
    end $$;
    create trigger retain_native_session_images after insert on pi_session_log
      for each row execute function retain_native_session_images();
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error(
    "Restore PG and its attachment inventory together; inline rollback is unsupported",
  );
}
