import { sql, type Kysely } from "kysely";
import * as encryptedTenantModelCredentials from "./007_encrypted_tenant_model_credentials.ts";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    update credential_bindings as binding
       set kind = 'brokered',
           secret_ref = 'provider-gateway://' || profile.provider || '/' || profile.model_id,
           updated_at = now()
      from model_profiles as profile
     where binding.tenant_id = profile.tenant_id
       and binding.id = profile.credential_binding_id
       and binding.version = profile.credential_binding_version
       and profile.provider in ('deepseek', 'openai-codex')
  `.execute(database);
  await sql`
    update credential_bindings
       set kind = 'brokered',
           secret_ref = 'provider-gateway://' || provider,
           updated_at = now()
     where kind = 'api_key'
       and provider in ('deepseek', 'openai-codex')
  `.execute(database);
  await sql`
    update model_profiles
       set default_thinking_level = 'off',
           allowed_thinking_levels = array['off','minimal','low','medium','high','xhigh','max']::text[],
           updated_at = now()
     where provider in ('deepseek', 'openai-codex')
  `.execute(database);
  await database.schema.dropTable("tenant_model_credentials").ifExists().execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await encryptedTenantModelCredentials.up(database);
}
