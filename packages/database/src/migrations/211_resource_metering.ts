import { sql, type Kysely } from "kysely";
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table resource_metering_resources (
      id text primary key, tenant_id uuid not null, workspace_id uuid not null,
      kind text not null check(kind in ('compute','workspace')), resource_id text not null,
      context jsonb not null, context_hash text not null,
      received_at timestamptz not null default clock_timestamp(),
      unique(kind,resource_id)
    );
    create index resource_metering_owner on resource_metering_resources(tenant_id,workspace_id,kind);
    create table resource_metering_events (
      id uuid primary key, resource_key text not null references resource_metering_resources(id),
      tenant_id uuid not null, workspace_id uuid not null, resource_kind text not null,
      from_at timestamptz not null, to_at timestamptz not null,
      quality text not null check(quality in ('confirmed','unconfirmed')),
      payload jsonb not null, payload_hash text not null, valuation jsonb not null,
      received_at timestamptz not null default clock_timestamp(),
      check (to_at >= from_at)
    );
    create index resource_metering_intervals on resource_metering_events(resource_key,from_at,to_at)
      where quality='confirmed';
    create index resource_metering_confirmed_ranges on resource_metering_events using gist (tstzrange(from_at,to_at,'[)')) where quality='confirmed';
    create index resource_metering_page on resource_metering_events(tenant_id,from_at desc,id desc);
    create index resource_metering_workspace_page on resource_metering_events(tenant_id,workspace_id,from_at desc,id desc);
    create table resource_rate_versions (
      id uuid primary key, tenant_id uuid not null,
      kind text not null check(kind in ('customer','upstream_estimate')),
      resource_kind text not null check(resource_kind in ('compute','workspace')),
      effective_at timestamptz not null, definition jsonb not null,
      created_at timestamptz not null default clock_timestamp(),
      unique(tenant_id,kind,resource_kind,effective_at)
    );
    create index resource_rate_lookup on resource_rate_versions(tenant_id,resource_kind,kind,effective_at desc);
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error(
    "Resource receipts require an explicit accounting export and matched publication",
  );
}
