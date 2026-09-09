import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table run_attempts add column output_display_seq bigint not null default 0
    check (output_display_seq >= 0),
    add column output_display_native_seq bigint not null default 0
    check (output_display_native_seq >= 0)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table run_attempts drop column output_display_seq,
    drop column output_display_native_seq`.execute(db);
}
