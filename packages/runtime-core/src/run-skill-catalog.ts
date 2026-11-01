import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseRunSkillCatalog,
  type SkillVersion,
  type SkillCatalogEntry,
} from "@pi-cloud/protocol";
type Db = Kysely<Database> | Transaction<Database>;
/** Called inside authorized root-Run admission. One immutable selection, including
 * an empty selection, survives Worker replacement and all native descendants. */
export async function pinRunSkillCatalog(
  db: Db,
  tenantId: string,
  runId: string,
): Promise<SkillCatalogEntry[]> {
  await sql`insert into run_skill_catalogs(tenant_id,run_id,versions)
   select r.tenant_id,r.id,coalesce((select jsonb_agg(chosen.version_id order by chosen.package_id)
     from (select distinct on(i.package_id) i.package_id,i.version_id,i.enabled
       from skill_installations i
       where i.tenant_id=r.tenant_id and ((i.scope_kind='personal' and i.scope_id=s.created_by_user_id)
         or (i.scope_kind='tenant' and i.scope_id=r.tenant_id)
         or (i.scope_kind='project' and i.scope_id=r.project_id))
       order by i.package_id,case i.scope_kind when 'project' then 0 when 'personal' then 1 else 2 end) chosen
     where chosen.enabled),'[]'::jsonb)
   from runs r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
   where r.tenant_id=${tenantId}::uuid and r.id=${runId}::uuid
   on conflict(run_id) do nothing`.execute(db);
  const versions = await readRunSkillCatalog(db, tenantId, runId);
  return parseRunSkillCatalog(
    versions.map(
      ({ versionId, packageId, name, description, digest, requirements, runtimeMetadata }) => ({
        versionId,
        packageId,
        name,
        description,
        digest,
        requirements,
        runtimeMetadata,
      }),
    ),
  );
}
export async function readRunSkillCatalog(
  db: Db,
  tenantId: string,
  runId: string,
): Promise<SkillVersion[]> {
  const { rows } = await sql<{
    selected: unknown;
    versions: SkillVersion[];
  }>`select c.versions as selected,
   coalesce((select jsonb_agg(jsonb_build_object(
      'versionId',v.id,'packageId',v.package_id,'name',p.name,'description',v.description,
      'label',v.label,'digest',v.digest,'byteLength',v.byte_length,'compatibility',v.compatibility,
      'requirements',v.requirements,'source',v.source,'runtimeMetadata',v.runtime_metadata) order by p.name,v.id)
    from jsonb_array_elements_text(c.versions) selected(id)
    join skill_versions v on v.tenant_id=c.tenant_id and v.id=selected.id::uuid and v.published
    join skill_packages p on p.tenant_id=v.tenant_id and p.id=v.package_id),'[]'::jsonb) as versions
   from run_skill_catalogs c where c.tenant_id=${tenantId}::uuid and c.run_id=${runId}::uuid`.execute(
    db,
  );
  const row = rows[0];
  if (!row || !Array.isArray(row.selected) || row.selected.length !== row.versions.length)
    throw Error("Run Skill selection is unavailable");
  if (row.versions.some((v) => !v.runtimeMetadata))
    throw Error("Skill metadata migration is incomplete");
  return row.versions;
}
