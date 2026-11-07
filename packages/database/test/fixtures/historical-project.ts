import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/index.ts";

// Frozen values accepted by the project/environment constraints at schemas
// 144–203. Historical fixtures must not inherit later application defaults or
// call today's createProject against a database deliberately stopped mid-upgrade.
const historicalEnvironment = {
  profileKey: "pi-cloud-fullstack",
  profileVersion: "1",
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipeSha256: "ba9924c0061bd35e002b13cad9746f3c9badaadeabce625bf3fae045bbae4618",
  recipe: {
    schemaVersion: 1,
    setupCommands: [],
    verificationCommands: [
      {
        id: "tool-root",
        command: "test -d . && test -w .",
        cwd: ".",
        timeoutMs: 10_000,
        network: "none",
      },
    ],
  },
} as const;

/** Seed only the pre-212 project contract. Capacity belongs to migration 212
 * and current application admission, never a compatibility branch in this SQL. */
export async function insertHistoricalProject(
  db: Kysely<Database>,
  input: { tenantId: string; name: string },
) {
  const projectId = randomUUID(),
    workspaceId = randomUUID(),
    environmentVersionId = randomUUID();
  return db.transaction().execute(async (tx) => {
    const domain = await sql<{ id: string }>`select id from sandbox_domains
      where state='active' order by id limit 1 for update`.execute(tx);
    const assigned = domain.rows[0];
    if (!assigned) throw new Error("Historical project fixture needs an active Sandbox Domain");
    const project = await sql<{ created_at: Date }>`insert into projects(id,tenant_id,name)
      values(${projectId}::uuid,${input.tenantId}::uuid,${input.name})
      returning created_at`.execute(tx);
    await sql`insert into workspaces(id,tenant_id,project_id,sandbox_domain_id,seed_kind)
      values(${workspaceId}::uuid,${input.tenantId}::uuid,${projectId}::uuid,${assigned.id},'empty')`.execute(
      tx,
    );
    await sql`update sandbox_domains set assigned_workspaces=assigned_workspaces+1,updated_at=now()
      where id=${assigned.id}`.execute(tx);
    const environment = await sql<{ created_at: Date }>`insert into environment_versions(
      id,tenant_id,project_id,version_number,profile_key,profile_version,image_revision,
      spec_sha256,recipe,recipe_sha256,state,active,validated_at)
      values(${environmentVersionId}::uuid,${input.tenantId}::uuid,${projectId}::uuid,1,
        ${historicalEnvironment.profileKey},${historicalEnvironment.profileVersion},
        ${historicalEnvironment.imageRevision},${historicalEnvironment.specSha256},
        ${JSON.stringify(historicalEnvironment.recipe)}::jsonb,${historicalEnvironment.recipeSha256},
        'pending',true,null) returning created_at`.execute(tx);
    return {
      projectId,
      workspaceId,
      name: input.name,
      createdAt: new Date(project.rows[0]!.created_at).toISOString(),
      source: { kind: "empty", status: "ready" } as const,
      environment: {
        ...structuredClone(historicalEnvironment),
        environmentVersionId,
        versionNumber: 1,
        state: "pending" as const,
        active: true,
        createdAt: new Date(environment.rows[0]!.created_at).toISOString(),
      },
    };
  });
}
