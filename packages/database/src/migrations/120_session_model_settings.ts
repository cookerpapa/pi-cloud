import { sql, type Kysely } from "kysely";

const thinkingLevels = sql`array['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']::text[]`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("desired_thinking_level", "text", (column) => column.notNull().defaultTo("off"))
    .addColumn("desired_service_tier", "text")
    .execute();
  await sql`alter table sessions add constraint sessions_desired_thinking_level_valid check (desired_thinking_level = any(${thinkingLevels}))`.execute(
    db,
  );
  await sql`alter table sessions add constraint sessions_desired_service_tier_valid check (desired_service_tier is null or desired_service_tier = 'fast')`.execute(
    db,
  );
  await db.schema.alterTable("turns").addColumn("service_tier", "text").execute();
  await sql`alter table turns add constraint turns_service_tier_valid check (service_tier is null or service_tier = 'fast')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("turns").dropConstraint("turns_service_tier_valid").execute();
  await db.schema.alterTable("turns").dropColumn("service_tier").execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_desired_service_tier_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropConstraint("sessions_desired_thinking_level_valid")
    .execute();
  await db.schema
    .alterTable("sessions")
    .dropColumn("desired_service_tier")
    .dropColumn("desired_thinking_level")
    .execute();
}
