import { sql, type Kysely } from "kysely";

/**
 * Retire platform-generated Diffs and post-Run commit tracking.
 *
 * Workspace bytes remain in persistent Cube Volumes. Git state is an ordinary
 * user-visible `.git` directory and is no longer represented by Patch artifacts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update session_terminal_events
       set payload = payload - 'workspacePatch'
     where type = 'turn.completed' and payload ? 'workspacePatch';

    update outbox
       set payload = jsonb_set(
         payload,
         '{event,payload}',
         coalesce(payload #> '{event,payload}', '{}'::jsonb) - 'workspacePatch'
       )
     where topic = 'pi-cloud.session-terminal-events.v1'
       and (payload #> '{event,payload}') ? 'workspacePatch';

    update workspace_versions set patch_artifact_id = null
     where patch_artifact_id is not null;
    delete from artifacts where kind = 'patch';
  `.execute(db);

  await db.schema
    .alterTable("workspace_versions")
    .dropConstraint("workspace_versions_patch_artifact_fk")
    .execute();
  await db.schema.alterTable("workspace_versions").dropColumn("patch_artifact_id").execute();

  await db.schema.alterTable("artifacts").dropConstraint("artifacts_kind_valid").execute();
  await db.schema
    .alterTable("artifacts")
    .addCheckConstraint(
      "artifacts_kind_valid",
      sql`kind in ('workspace_snapshot', 'tool_output', 'report', 'crash_bundle')`,
    )
    .execute();

  await db.schema
    .alterTable("source_control_issue_jobs")
    .dropConstraint("source_control_issue_jobs_commit_sha_check")
    .execute();
  await db.schema.alterTable("source_control_issue_jobs").dropColumn("commit_sha").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "108_remove_platform_git_change_tracking is destructive; restore a pre-migration backup to roll back",
  );
}
