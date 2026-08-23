import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("development_environments").addColumn("ip_address", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("development_environments").dropColumn("ip_address").execute();
}
