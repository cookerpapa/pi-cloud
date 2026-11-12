import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>) {
  await sql`alter table sandbox_domains drop constraint sandbox_domains_id_valid,
    drop constraint sandbox_domains_tool_broker_base_url_key;
  alter table sandbox_domains add constraint sandbox_domains_id_valid check(id ~ '^[A-Za-z0-9_.-]{1,64}$');
  drop index tool_broker_ready_owner_url_unique;
  create unique index tool_broker_ready_owner_url_unique on sandbox_control_instances(sandbox_domain_id,owner_base_url) where state='ready';
  alter table sandbox_domains
    add column backend_revision bigint not null default 0 check(backend_revision>=0),
    add column backend_endpoint text unique,
    add column backend_location text not null default '',
    add column backend_configuration text,
    add column backend_catalog jsonb;
  alter table workspaces add column backend_template_id text;
  create function pi_cloud_resource_backends_changed() returns trigger language plpgsql as $$
  begin perform pg_notify('pi_cloud_resource_backends','changed'); return new; end $$;
  create trigger pi_cloud_resource_backends_changed after insert or update on sandbox_domains
    for each statement execute function pi_cloud_resource_backends_changed();`.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Backend ownership requires a matched forward update");
}
