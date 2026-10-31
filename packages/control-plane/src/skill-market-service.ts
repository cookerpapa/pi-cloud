import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { retryTransaction, type Database } from "@pi-cloud/database";
import {
  SKILL_ENVELOPE_BYTES,
  skillAvailability,
  type SkillImport,
  type SkillInstallationChange,
  type SkillVersion,
  type SkillMarket,
  type SkillInstallation,
  type SkillScope,
  type SkillPackageContent,
} from "@pi-cloud/protocol";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { TenantRequestContextError } from "./tenant-request-context.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import { skillPackage, importGitHubSkill } from "./skill-package.ts";

type Actor = Pick<TenantRequestIdentity, "tenantId" | "userId" | "role">;
export interface SkillPackageBlobs {
  put(key: string, bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<void>;
  readStream(key: string, maximumBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
type VersionRow = {
  published: boolean;
  id: string;
  package_id: string;
  name: string;
  digest: string;
  byte_length: string;
  label: string;
  description: string;
  compatibility: string;
  requirements: SkillVersion["requirements"];
  source: SkillVersion["source"];
  object_key: string;
};
const version = (row: VersionRow): SkillVersion => ({
  versionId: row.id,
  packageId: row.package_id,
  name: row.name,
  digest: row.digest,
  byteLength: Number(row.byte_length),
  label: row.label,
  description: row.description,
  compatibility: row.compatibility,
  requirements: row.requirements,
  source: row.source,
});
const conflict = (message: string): never => {
  throw new ControlPlaneStoreError("conflict", message);
};
const notFound = (): never => {
  throw new ControlPlaneStoreError("not_found", "Skill was not found in this scope");
};

/** Catalog is configuration, not an execution scheduler or another native history. */
export class SkillMarketService {
  constructor(
    readonly options: {
      database: Kysely<Database>;
      blobs?: SkillPackageBlobs;
      catalog?(): readonly import("@pi-cloud/protocol").ControlToolCatalogDefinition[];
      fetch?: typeof fetch;
    },
  ) {}

  async publish(
    actor: Actor,
    input: SkillImport,
    signal = new AbortController().signal,
  ): Promise<SkillVersion> {
    if (actor.role === "viewer")
      throw new TenantRequestContextError(
        "authorization_denied",
        "Skill publishing requires mutation permission",
      );
    if (!this.options.blobs)
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Skill object storage is unavailable",
      );
    const imported =
      input.source.kind === "github"
        ? await importGitHubSkill(input.source, this.options.fetch ?? fetch, signal)
        : { files: input.source.files, source: { kind: "files" as const } };
    const parsed = skillPackage(imported.files);
    const requirements = {
      runtime: input.requirements.runtime,
      tools: [...input.requirements.tools].sort(),
      software: [...input.requirements.software].sort(),
    };
    const body = Buffer.from(JSON.stringify({ ...parsed.content, requirements }));
    const digest = createHash("sha256").update(body).digest("hex");
    const db = this.options.database;
    // Inventory precedes the object write. An uncertain PUT is safe to retry:
    // this key can only ever contain these immutable bytes, and has no effects.
    const row = await db.transaction().execute(async (tx) => {
      let packages;
      if (input.packageId)
        packages = await sql<{
          id: string;
          name: string;
          owner_user_id: string;
        }>`select id,name,owner_user_id from skill_packages
        where tenant_id=${actor.tenantId}::uuid and id=${input.packageId}::uuid for update`.execute(
          tx,
        );
      else
        packages = await sql<{
          id: string;
          name: string;
          owner_user_id: string;
        }>`insert into skill_packages(id,tenant_id,owner_user_id,name)
        values(${randomUUID()}::uuid,${actor.tenantId}::uuid,${actor.userId}::uuid,${parsed.content.name})
        on conflict(tenant_id,owner_user_id,name) do update set name=excluded.name returning id,name,owner_user_id`.execute(
          tx,
        );
      const pack = packages.rows[0];
      if (!pack || pack.owner_user_id !== actor.userId) return notFound();
      if (pack.name !== parsed.content.name)
        return conflict("A version cannot rename its Skill package");
      const key = `skills/${actor.tenantId}/${digest}.json`;
      const rows =
        await sql<VersionRow>`insert into skill_versions(id,tenant_id,package_id,digest,object_key,byte_length,label,description,compatibility,requirements,source)
        values(${randomUUID()}::uuid,${actor.tenantId}::uuid,${pack.id}::uuid,${digest},${key},${parsed.byteLength},${input.label},${parsed.description},${parsed.compatibility},${JSON.stringify(requirements)}::jsonb,${JSON.stringify(imported.source)}::jsonb)
        on conflict(tenant_id,package_id,digest) do update set digest=excluded.digest
        returning *,${pack.name}::text as name`.execute(tx);
      return rows.rows[0]!;
    });
    if (row.published) return version(row);
    await this.options.blobs.put(row.object_key, body, "application/json", signal);
    signal.throwIfAborted();
    await sql`update skill_versions set published=true where tenant_id=${actor.tenantId}::uuid and id=${row.id}::uuid`.execute(
      db,
    );
    return version(row);
  }

  async #scope(actor: Actor, scope: SkillScope, mutation: boolean): Promise<string> {
    if (mutation && actor.role === "viewer")
      throw new TenantRequestContextError(
        "authorization_denied",
        "Skill installation requires mutation permission",
      );
    if (scope.kind === "personal") return actor.userId;
    if (mutation && actor.role !== "owner")
      throw new TenantRequestContextError(
        "authorization_denied",
        "Shared Skill installation requires an owner",
      );
    if (scope.kind === "tenant") return actor.tenantId;
    const project = await this.options.database
      .selectFrom("projects")
      .select("id")
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", scope.projectId)
      .executeTakeFirst();
    if (!project) return notFound();
    return project.id;
  }
  async install(
    actor: Actor,
    packageId: string,
    change: SkillInstallationChange,
  ): Promise<SkillInstallation> {
    const scopeId = await this.#scope(actor, change.scope, true);
    const rows = await sql<{
      revision: string;
    }>`insert into skill_installations(tenant_id,package_id,version_id,scope_kind,scope_id,enabled)
      select ${actor.tenantId}::uuid,${packageId}::uuid,v.id,${change.scope.kind},${scopeId}::uuid,${change.enabled}
      from skill_versions v where v.tenant_id=${actor.tenantId}::uuid and v.package_id=${packageId}::uuid and v.id=${change.versionId}::uuid and v.published and (${change.revision}::bigint is null or exists(select 1 from skill_installations i where i.tenant_id=v.tenant_id and i.package_id=v.package_id and i.scope_kind=${change.scope.kind} and i.scope_id=${scopeId}::uuid))
      on conflict(tenant_id,scope_kind,scope_id,package_id) do update set version_id=excluded.version_id,enabled=excluded.enabled,revision=skill_installations.revision+1
      where skill_installations.revision=${change.revision}::bigint
      returning revision`.execute(this.options.database);
    if (!rows.rows[0])
      return conflict(
        "Skill version is unavailable or the installation changed; reload before retrying",
      );
    return {
      scope: change.scope,
      versionId: change.versionId,
      enabled: change.enabled,
      revision: rows.rows[0].revision,
    };
  }
  async uninstall(
    actor: Actor,
    packageId: string,
    scope: SkillScope,
    revision: string,
  ): Promise<void> {
    const scopeId = await this.#scope(actor, scope, true);
    const rows =
      await sql`delete from skill_installations where tenant_id=${actor.tenantId}::uuid and package_id=${packageId}::uuid
      and scope_kind=${scope.kind} and scope_id=${scopeId}::uuid and revision=${revision}::bigint returning package_id`.execute(
        this.options.database,
      );
    if (!rows.rows.length) return conflict("Installation changed; reload before removing it");
  }

  async list(actor: Actor, projectId?: string, cursor?: string): Promise<SkillMarket> {
    if (projectId) await this.#scope(actor, { kind: "project", projectId }, false);
    const packages = await sql<{
      id: string;
      owner_user_id: string;
    }>`select id,owner_user_id from skill_packages p
      where tenant_id=${actor.tenantId}::uuid and (${cursor ?? null}::uuid is null or id>${cursor ?? null}::uuid)
      and exists(select 1 from skill_versions v where v.package_id=p.id and v.published) order by id limit 31`.execute(
      this.options.database,
    );
    const visible = packages.rows.slice(0, 30);
    if (!visible.length) return { packages: [], nextCursor: null };
    const ids = visible.map((row) => row.id);
    const versions =
      await sql<VersionRow>`select v.*,p.name from skill_packages p cross join lateral
      (select * from skill_versions where package_id=p.id and published order by created_at desc,id desc limit 20) v
      where p.tenant_id=${actor.tenantId}::uuid and p.id=any(${ids}::uuid[]) order by p.id,v.created_at desc,v.id desc`.execute(
        this.options.database,
      );
    const installations = await sql<{
      package_id: string;
      version_id: string;
      scope_kind: "personal" | "tenant" | "project";
      scope_id: string;
      enabled: boolean;
      revision: string;
    }>`select * from skill_installations
      where tenant_id=${actor.tenantId}::uuid and package_id=any(${ids}::uuid[]) and
      ((scope_kind='personal' and scope_id=${actor.userId}::uuid) or (scope_kind='tenant' and scope_id=${actor.tenantId}::uuid) or (scope_kind='project' and scope_id=${projectId ?? null}::uuid))`.execute(
      this.options.database,
    );
    const missing = installations.rows
      .map((row) => row.version_id)
      .filter((id) => !versions.rows.some((v) => v.id === id));
    if (missing.length) {
      const older =
        await sql<VersionRow>`select v.*,p.name from skill_versions v join skill_packages p on p.id=v.package_id
        where v.tenant_id=${actor.tenantId}::uuid and v.id=any(${missing}::uuid[]) and v.published`.execute(
          this.options.database,
        );
      versions.rows.push(...older.rows);
    }
    return {
      packages: visible.map((pack) => {
        const v = versions.rows.filter((row) => row.package_id === pack.id).map(version);
        return {
          packageId: pack.id,
          ownerUserId: pack.owner_user_id,
          versions: v.map((value) => ({
            ...value,
            availability: skillAvailability(value.requirements, "linux", this.#tools()),
          })),
          installations: installations.rows
            .filter((row) => row.package_id === pack.id)
            .map((row) => ({
              scope:
                row.scope_kind === "project"
                  ? { kind: "project" as const, projectId: row.scope_id }
                  : { kind: row.scope_kind },
              versionId: row.version_id,
              enabled: row.enabled,
              revision: row.revision,
            })),
        };
      }),
      nextCursor: packages.rows.length > 30 ? visible.at(-1)!.id : null,
    };
  }
  #tools(root = true) {
    return [
      "read",
      "write",
      "edit",
      "bash",
      "subagent",
      "workflow",
      ...(this.options
        .catalog?.()
        .filter((tool) => root || tool.availability !== "root")
        .map((tool) => tool.name) ?? ["read_skill", "prepare_skill"]),
    ];
  }

  async runCapabilities(tenantId: string, runId: string, conversationId?: number) {
    const run = await this.options.database
      .selectFrom("runs as r")
      .innerJoin("sessions as s", "s.id", "r.session_id")
      .select(["r.thinking_level", "s.pi_conversation_id"])
      .where("r.tenant_id", "=", tenantId)
      .where("r.id", "=", runId)
      .executeTakeFirst();
    if (!run) return notFound();
    const tools = this.#tools(
      conversationId === undefined || Number(run.pi_conversation_id) === conversationId,
    ).filter((name) => name !== "subagent" && name !== "workflow");
    if (run.thinking_level === "ultra") tools.push("subagent", "workflow");
    return {
      runtime: "linux" as const,
      tools,
    };
  }
  async runCatalog(tenantId: string, runId: string): Promise<SkillVersion[]> {
    const db = this.options.database;
    const existing = await sql<{
      versions: string[];
    }>`select versions from run_skill_catalogs where tenant_id=${tenantId}::uuid and run_id=${runId}::uuid`.execute(
      db,
    );
    let ids = existing.rows[0]?.versions;
    if (!ids) {
      ids = await retryTransaction(db, async (tx) => {
        await sql`set transaction isolation level repeatable read`.execute(tx);
        const roots = await sql<{
          user_id: string;
          project_id: string;
        }>`select s.created_by_user_id as user_id,r.project_id from runs r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
          where r.tenant_id=${tenantId}::uuid and r.id=${runId}::uuid`.execute(tx);
        const root = roots.rows[0];
        if (!root) return notFound();
        // A nearer disabled installation masks a wider installation, too.
        const installed = await sql<{
          version_id: string;
          enabled: boolean;
        }>`select distinct on(package_id) version_id,enabled from skill_installations
          where tenant_id=${tenantId}::uuid and ((scope_kind='personal' and scope_id=${root.user_id}::uuid)
          or (scope_kind='tenant' and scope_id=${tenantId}::uuid) or (scope_kind='project' and scope_id=${root.project_id}::uuid))
          order by package_id,case scope_kind when 'project' then 0 when 'personal' then 1 else 2 end`.execute(
          tx,
        );
        const selected = installed.rows.filter((row) => row.enabled).map((row) => row.version_id);
        // ON CONFLICT also handles concurrent first use by parent/child Tools.
        const result = await sql<{
          versions: string[];
        }>`insert into run_skill_catalogs(tenant_id,run_id,versions)
          values(${tenantId}::uuid,${runId}::uuid,${JSON.stringify(selected)}::jsonb)
          on conflict(run_id) do update set versions=run_skill_catalogs.versions returning versions`.execute(
          tx,
        );
        return result.rows[0]!.versions;
      });
    }
    if (!ids.length) return [];
    const rows =
      await sql<VersionRow>`select v.*,p.name from skill_versions v join skill_packages p on p.id=v.package_id
      where v.tenant_id=${tenantId}::uuid and v.id=any(${ids}::uuid[]) and v.published order by p.name,v.id`.execute(
        db,
      );
    return rows.rows.map(version);
  }
  async content(
    tenantId: string,
    versionId: string,
    signal = new AbortController().signal,
  ): Promise<SkillPackageContent> {
    const rows = await sql<{
      object_key: string;
      digest: string;
    }>`select object_key,digest from skill_versions where tenant_id=${tenantId}::uuid and id=${versionId}::uuid and published`.execute(
      this.options.database,
    );
    const row = rows.rows[0];
    if (!row) return notFound();
    if (!this.options.blobs) throw new Error("Skill object storage is unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this.options.blobs.readStream(
      row.object_key,
      SKILL_ENVELOPE_BYTES,
      signal,
    )) {
      size += chunk.byteLength;
      if (size > SKILL_ENVELOPE_BYTES) throw new Error("Skill object exceeded its envelope");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (createHash("sha256").update(body).digest("hex") !== row.digest)
      throw new Error("Skill object digest changed");
    return JSON.parse(body.toString("utf8")) as SkillPackageContent;
  }
}
