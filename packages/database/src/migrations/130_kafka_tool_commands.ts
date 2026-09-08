import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state in ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from outbox where published_at is null)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null) then
      raise exception 'Drain Runs and terminal Outbox before Kafka Tool command cutover';
    end if;
  end $$`.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Kafka Tool command rollback requires a drained protocol deployment");
}
