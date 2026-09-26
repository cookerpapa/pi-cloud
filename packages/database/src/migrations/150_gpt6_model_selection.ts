import { sql, type Kysely } from "kysely";

/** Upgrade future selections; accepted Turn/Run snapshots remain immutable. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update model_profiles
       set model_id = case model_id
         when 'gpt-5.6-luna' then 'gpt-6-luna'
         else 'gpt-6-sol' end,
           updated_at = clock_timestamp()
     where provider = 'openai-codex'
       and model_id in ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
  `.execute(db);
  await sql`
    update credential_bindings
       set secret_ref = replace(replace(replace(secret_ref,
         '/gpt-5.6-luna', '/gpt-6-luna'), '/gpt-5.6-sol', '/gpt-6-sol'),
         '/gpt-5.6-terra', '/gpt-6-sol')
     where provider = 'openai-codex' and kind = 'brokered'
       and secret_ref like 'provider-gateway://openai-codex/gpt-5.6-%'
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore the pre-GPT-6 database backup; model history is not rewritten");
}
