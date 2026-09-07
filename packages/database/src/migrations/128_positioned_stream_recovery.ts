import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state in ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from outbox where published_at is null)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null) then
      raise exception 'Drain Runs and seal Outbox before positioned stream cutover';
    end if;
  end $$`.execute(db);
  await sql`alter table run_attempts add column output_seal_offset bigint`.execute(db);
  await sql`create table accepted_fact_projection_offsets (
    topic text not null, partition integer not null, next_offset bigint not null,
    primary key(topic, partition), check(partition >= 0 and next_offset >= 0)
  )`.execute(db);
  await sql`create index run_attempts_unsealed_output_start
    on run_attempts(output_first_topic,output_first_partition,output_first_offset)
    where output_sealed_at is null and output_first_offset is not null`.execute(db);
  await sql`create index run_attempts_unobserved_output on run_attempts(claimed_at)
    where output_sealed_at is null and output_first_offset is null
      and (running_at is not null or output_seal_id is not null)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index run_attempts_unobserved_output`.execute(db);
  await sql`drop index run_attempts_unsealed_output_start`.execute(db);
  await sql`drop table accepted_fact_projection_offsets`.execute(db);
  await sql`alter table run_attempts drop column output_seal_offset`.execute(db);
}
