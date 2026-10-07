import { sql, type Kysely } from "kysely";

/** Page visible Session headers before looking up their Turn counts. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`create index sessions_visible_activity_page
    on sessions(tenant_id,last_active_at desc,id desc)
    where session_kind='conversation' and pruned_at is null`.execute(database);
}

export async function down<DB>(database: Kysely<DB>): Promise<void> {
  await database.schema.dropIndex("sessions_visible_activity_page").execute();
}
