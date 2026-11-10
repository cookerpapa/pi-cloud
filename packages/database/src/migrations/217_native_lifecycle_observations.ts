import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>) {
  await sql`
    alter table resource_lifecycle_sources add column source_position text
      check(source_position is null or octet_length(source_position)<=1024);
    alter table resource_metering_resources add column provider_binding jsonb
      check(provider_binding is null or (jsonb_typeof(provider_binding)='object' and octet_length(provider_binding::text)<=2048));
    create unique index resource_provider_binding on resource_metering_resources
      ((provider_binding->>'sourceId'),(provider_binding->>'resourceId')) where provider_binding is not null;
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Native provider attribution requires a matched release");
}
