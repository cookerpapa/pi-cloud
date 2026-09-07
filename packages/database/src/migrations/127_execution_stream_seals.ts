import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state in
      ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from outbox where published_at is null) then
      raise exception 'Drain active Runs and terminal Outbox before execution stream seal cutover';
    end if;
  end $$`.execute(db);
  await sql`alter table run_attempts
    add column output_seal_id uuid,
    add column output_sealed_at timestamptz,
    add column output_first_topic text,
    add column output_first_partition integer,
    add column output_first_offset bigint,
    add column output_projected_offset bigint`.execute(db);
  // Cutover requires drained/stopped publishers and a new Kafka topic.
  // Historical canonical user data is preserved, not replayed.
  await sql`update run_attempts set output_sealed_at = coalesce(settled_at, now())
    where state in ('completed','failed','cancelled','timed_out','superseded')`.execute(db);
  await sql`create index run_attempts_pending_output_seal on run_attempts(tenant_id, run_id)
    where output_seal_id is not null and output_sealed_at is null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table run_attempts drop column output_seal_id,
    drop column output_sealed_at, drop column output_first_topic,
    drop column output_first_partition, drop column output_first_offset,
    drop column output_projected_offset`.execute(db);
}
