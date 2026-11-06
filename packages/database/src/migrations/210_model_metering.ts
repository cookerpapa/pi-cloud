import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Financial attribution survives deletion of the original chat resources.
    create table model_invocations (
      id uuid primary key, tenant_id uuid not null, session_id uuid not null,
      run_id uuid not null, requested_at timestamptz not null,
      provider text not null, model text not null, purpose text not null,
      context jsonb not null, context_hash text not null,
      received_at timestamptz not null default clock_timestamp()
    );
    create index model_invocations_tenant_time on model_invocations(tenant_id,requested_at desc,id desc);
    create index model_invocations_session_time on model_invocations(tenant_id,session_id,requested_at desc,id desc);
    create table model_metering_events (
      id text primary key, invocation_id uuid not null references model_invocations(id),
      kind text not null check(kind in ('started','attempt','usage','finished','interrupted')),
      execution_id uuid, occurred_at timestamptz not null,
      payload jsonb not null, payload_hash text not null, valuation jsonb,
      received_at timestamptz not null default clock_timestamp()
    );
    create index model_metering_events_invocation on model_metering_events(invocation_id,kind);
    create unique index model_metering_usage_execution on model_metering_events(execution_id) where kind='usage';
    create table model_rate_versions (
      id uuid primary key, tenant_id uuid not null,
      kind text not null check(kind in ('customer','upstream_estimate')),
      provider text not null, model text not null, service_tier text not null,
      effective_at timestamptz not null, definition jsonb not null,
      created_at timestamptz not null default clock_timestamp(),
      unique(tenant_id,kind,provider,model,service_tier,effective_at)
    );
    create index model_rate_lookup on model_rate_versions(tenant_id,provider,model,service_tier,kind,effective_at desc);
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error(
    "Metering receipts require an explicit financial-data export and matched publication",
  );
}
