import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    update model_profiles
       set default_thinking_level = 'off',
           allowed_thinking_levels = array['off','minimal','low','medium','high','xhigh','max']::text[],
           updated_at = now()
     where provider = 'openai-codex'
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    update model_profiles
       set default_thinking_level = 'medium',
           allowed_thinking_levels = array['minimal','low','medium','high','xhigh','max']::text[],
           updated_at = now()
     where provider = 'openai-codex'
  `.execute(database);
}
