import { sql, type Kysely } from "kysely";
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
  alter table sandboxes alter column max_concurrent_sessions drop not null;
  alter table supervisor_hosts alter column maximum_capacity drop not null;
  alter table supervisor_hosts drop constraint supervisor_hosts_capacity_valid;
  alter table supervisor_hosts add constraint supervisor_hosts_capacity_valid check (maximum_capacity > 0);
  alter table tenant_runtime_policies
    alter column maximum_model_requests_per_run drop not null,
    alter column maximum_model_requests_per_run drop default,
    alter column maximum_tool_calls_per_run drop not null,
    alter column maximum_tool_calls_per_run drop default;
  update sandboxes set max_concurrent_sessions=null;
  update supervisor_hosts set maximum_capacity=null;
  update tenant_runtime_policies set maximum_model_requests_per_run=null,maximum_tool_calls_per_run=null;
 `.execute(db);
}
export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
  update sandboxes set max_concurrent_sessions=coalesce(max_concurrent_sessions,4);
  update supervisor_hosts set maximum_capacity=coalesce(maximum_capacity,16);
  update tenant_runtime_policies set maximum_model_requests_per_run=coalesce(maximum_model_requests_per_run,128),maximum_tool_calls_per_run=coalesce(maximum_tool_calls_per_run,128);
  alter table sandboxes alter column max_concurrent_sessions set not null;
  alter table supervisor_hosts alter column maximum_capacity set not null;
  alter table supervisor_hosts drop constraint supervisor_hosts_capacity_valid;
  alter table supervisor_hosts add constraint supervisor_hosts_capacity_valid check (maximum_capacity > 0 and maximum_capacity <= 256);
  alter table tenant_runtime_policies
    alter column maximum_model_requests_per_run set default 128,
    alter column maximum_model_requests_per_run set not null,
    alter column maximum_tool_calls_per_run set default 128,
    alter column maximum_tool_calls_per_run set not null;
 `.execute(db);
}
