import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists (select 1 from runs where state in ('queued','running','settling','cancel_requested')
      or recovery_requested_at is not null
      or (output_seal_id is not null and output_sealed_at is null)) then
      raise exception 'Drain Runs before changing the model runtime contract';
    end if;
  end $$`.execute(db);
  await sql`alter table runs add column model_runtime_snapshot jsonb
    check (model_runtime_snapshot is null or jsonb_typeof(model_runtime_snapshot) = 'object')`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  throw new Error("Model runtime snapshots require the matched application contract");
}
