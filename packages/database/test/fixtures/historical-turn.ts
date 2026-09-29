import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/index.ts";

/** Seed the old storage contract directly. Current admission must never contain
 * compatibility branches merely to manufacture pre-cutover test fixtures. */
export async function insertHistoricalPrompt(
  db: Kysely<Database>,
  input: {
    tenantId: string;
    sessionId: string;
    projectId: string;
    workspaceId: string;
    modelProfileId: string;
    environmentVersionId: string;
    prompt: string;
  },
) {
  const turnId = randomUUID(),
    runId = randomUUID();
  await sql`insert into turns(id,tenant_id,session_id,state,input_kind,input_text,
    model_profile_id,provider,model_id,thinking_level,credential_binding_id,credential_binding_version)
    select ${turnId}::uuid,tenant_id,${input.sessionId}::uuid,'queued','prompt',${input.prompt},id,
      provider,model_id,default_thinking_level,credential_binding_id,credential_binding_version
    from model_profiles where tenant_id=${input.tenantId}::uuid and id=${input.modelProfileId}::uuid`.execute(
    db,
  );
  await sql`insert into runs(id,tenant_id,project_id,workspace_id,session_id,turn_id,environment_version_id,
    idempotency_key,mailbox_position,request_sha256,available_at,state)
    values(${runId}::uuid,${input.tenantId}::uuid,${input.projectId}::uuid,${input.workspaceId}::uuid,
      ${input.sessionId}::uuid,${turnId}::uuid,${input.environmentVersionId}::uuid,
      'historical',1,${"a".repeat(64)},now(),'queued')`.execute(db);
  await sql`update sessions set next_mailbox_position=2 where id=${input.sessionId}::uuid`.execute(
    db,
  );
  return { turnId, runId };
}
