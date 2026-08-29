import { sql, type Kysely } from "kysely";

/** Keep Issue automation focused on Run creation; delivery remains user-directed. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("source_control_issue_jobs")
    .addColumn("session_title", "text")
    .execute();
  await sql`
    update source_control_issue_jobs
       set session_title = left(issue_title, 256)
     where session_title is null;

    update source_control_issue_jobs
       set state = 'completed',
           owner_id = null,
           lease_expires_at = null,
           settled_at = coalesce(settled_at, now()),
           updated_at = now()
     where state = 'publishing';
  `.execute(db);
  await db.schema
    .alterTable("source_control_issue_jobs")
    .alterColumn("session_title", (column) => column.setNotNull())
    .execute();
  await sql`
    alter table source_control_issue_jobs
      add constraint source_control_issue_jobs_session_title_check
        check (char_length(session_title) between 1 and 256),
      drop constraint source_control_issue_jobs_state_check,
      add constraint source_control_issue_jobs_state_check
        check (state in (
          'awaiting_claim', 'received', 'provisioning', 'queued',
          'running', 'completed', 'failed', 'cancelled'
        )),
      drop column change_request_number,
      drop column change_request_url,
      drop column issue_comment_id;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "110_user_directed_issue_sessions is destructive; restore a pre-migration backup to roll back",
  );
}
