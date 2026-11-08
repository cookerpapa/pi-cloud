import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table tool_catalog_publication (
      scope text primary key check(scope='platform'),
      generation bigint not null check(generation>0),
      release_id text not null,
      catalog text not null,
      replayable jsonb not null,
      published_generation bigint,
      updated_at timestamptz not null default clock_timestamp()
    );
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Tool catalog authority requires a matched rollback");
}
