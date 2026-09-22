import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
        or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain active Runs before changing Tool dispatch/reply contracts'; end if;
    end $$;
    drop table tool_broker_operations;
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Retired Tool operation history is not restored");
}
