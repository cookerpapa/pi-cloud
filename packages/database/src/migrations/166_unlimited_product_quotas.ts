import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    alter table tenant_runtime_policies
      alter column maximum_projects drop not null,
      alter column maximum_projects drop default,
      alter column maximum_sessions drop not null,
      alter column maximum_sessions drop default;
    alter table sandbox_domains
      alter column maximum_active_sandboxes drop not null,
      alter column maximum_active_sandboxes drop default;
    update tenant_runtime_policies set maximum_projects=null, maximum_sessions=null;
    update sandbox_domains set maximum_active_sandboxes=null;
  `.execute(database);
}
export async function down<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    update tenant_runtime_policies set maximum_projects=coalesce(maximum_projects,100),
      maximum_sessions=coalesce(maximum_sessions,1000);
    update sandbox_domains set maximum_active_sandboxes=coalesce(maximum_active_sandboxes,1024);
    alter table tenant_runtime_policies
      alter column maximum_projects set default 100,
      alter column maximum_projects set not null,
      alter column maximum_sessions set default 1000,
      alter column maximum_sessions set not null;
    alter table sandbox_domains
      alter column maximum_active_sandboxes set default 1024,
      alter column maximum_active_sandboxes set not null;
  `.execute(database);
}
