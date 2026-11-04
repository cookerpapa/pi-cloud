import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table session_image_objects rename to session_attachment_objects;
    alter table session_attachment_objects drop constraint session_image_objects_mime_type_check;
    alter table session_attachment_objects add constraint session_attachment_mime_type
      check(length(mime_type) between 3 and 128 and mime_type ~ '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$');
    alter table session_image_references rename to session_attachment_references;
    alter table session_attachment_references rename column image_id to attachment_id;
    alter table pi_history_record_images rename to pi_history_record_attachments;
    alter table pi_history_record_attachments rename column image_id to attachment_id;
    alter table pi_history_header_images rename to pi_history_header_attachments;
    alter table pi_history_header_attachments rename column image_id to attachment_id;
    alter table session_uploads rename column image_id to attachment_id;
    alter table session_uploads rename column image_reference to source_reference;
    drop function if exists retain_native_session_images();
    drop function if exists native_session_image_references(jsonb);
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Retained attachments require a matched application/storage version");
}
