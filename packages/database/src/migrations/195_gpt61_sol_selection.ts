import { sql, type Kysely } from "kysely";

/** Future settings only. Accepted Run snapshots and native model history are immutable. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists (select 1 from runs where provider = 'openai-codex'
        and model_id = 'gpt-6-sol'
        and (state in ('queued', 'running', 'settling', 'cancel_requested')
          or recovery_requested_at is not null
          or (output_seal_id is not null and output_sealed_at is null))) then
        raise exception 'Drain GPT-6 Sol Runs before migrating the model catalog';
      end if;
    end $$
  `.execute(db);
  await sql`
    update sessions s set desired_thinking_level = 'medium'
      from model_profiles p
     where s.tenant_id = p.tenant_id and s.desired_model_profile_id = p.id
       and p.provider = 'openai-codex' and p.model_id = 'gpt-6-sol'
       and s.desired_thinking_level in ('off', 'minimal')
  `.execute(db);
  await sql`
    update model_profiles p
       set model_id = 'gpt-6.1-sol',
           default_thinking_level = case when default_thinking_level in ('off', 'minimal')
             then 'medium' else default_thinking_level end,
           allowed_thinking_levels = array(
             select case when level in ('off', 'minimal') then 'medium' else level end
               from unnest(p.allowed_thinking_levels) with ordinality as levels(level, ordinal)
              group by 1 order by min(ordinal)),
           updated_at = clock_timestamp()
     where provider = 'openai-codex' and model_id = 'gpt-6-sol'
  `.execute(db);
  await sql`
    update credential_bindings
       set secret_ref = 'provider-gateway://openai-codex/gpt-6.1-sol',
           updated_at = clock_timestamp()
     where provider = 'openai-codex' and kind = 'brokered'
       and secret_ref = 'provider-gateway://openai-codex/gpt-6-sol'
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("GPT-6.1 Sol selection migration is forward-only; deploy a matched catalog");
}
