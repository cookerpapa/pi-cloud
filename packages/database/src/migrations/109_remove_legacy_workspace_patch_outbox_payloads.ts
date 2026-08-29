import { sql, type Kysely } from "kysely";

/** Remove the final persisted copies of the retired Workspace Patch protocol. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update outbox
       set payload = jsonb_set(
         payload,
         '{event,payload}',
         coalesce(payload #> '{event,payload}', '{}'::jsonb) - 'workspacePatch'
       )
     where topic = 'session.event.accepted.v1'
       and (payload #> '{event,payload}') ? 'workspacePatch';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "109_remove_legacy_workspace_patch_outbox_payloads is destructive; restore a pre-migration backup to roll back",
  );
}
