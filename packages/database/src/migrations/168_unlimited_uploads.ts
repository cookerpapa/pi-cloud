import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table session_uploads drop constraint session_uploads_byte_length_check;
    alter table session_uploads add constraint session_uploads_byte_length_check check(byte_length > 0);
    alter table session_image_objects drop constraint session_image_objects_byte_length_check;
    alter table session_image_objects add constraint session_image_objects_byte_length_check check(byte_length > 0);
    alter table turns drop constraint turns_input_uploads_check;
    alter table turns add constraint turns_input_uploads_check check(jsonb_typeof(input_uploads)='array');
  `.execute(db);
}
export async function down(): Promise<void> {
  throw new Error(
    "Upload protocol v2 requires a matched deployment; restore a pre-cutover database to roll back",
  );
}
