import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from web_sessions where authentication_kind = 'oidc';

    alter table web_sessions
      drop constraint web_sessions_authentication_shape,
      drop constraint web_sessions_external_identity_fk,
      drop column external_identity_id,
      drop column authentication_kind;

    drop table oidc_authentication_requests;
    drop table external_identities;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "116_remove_oidc_login is destructive; restore a pre-migration backup to roll back",
  );
}
