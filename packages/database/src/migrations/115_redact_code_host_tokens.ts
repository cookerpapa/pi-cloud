import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update pi_session_entries
       set payload = regexp_replace(
         regexp_replace(
           regexp_replace(
             payload::text,
             '(glpat|gldt|glcbt|glptt)-[A-Za-z0-9._~-]{8,}',
             '[PI_CLOUD_REDACTED]',
             'g'
           ),
           'github_pat_[A-Za-z0-9_]{8,}',
           '[PI_CLOUD_REDACTED]',
           'g'
         ),
         'gh[pousr]_[A-Za-z0-9]{8,}',
         '[PI_CLOUD_REDACTED]',
         'g'
       )::jsonb
     where payload::text ~ '(glpat|gldt|glcbt|glptt)-[A-Za-z0-9._~-]{8,}'
        or payload::text ~ 'github_pat_[A-Za-z0-9_]{8,}'
        or payload::text ~ 'gh[pousr]_[A-Za-z0-9]{8,}';
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("115_redact_code_host_tokens cannot restore redacted secrets");
}
