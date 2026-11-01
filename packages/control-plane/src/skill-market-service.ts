import { readRunSkillCatalog } from "@pi-cloud/runtime-core";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { type Database } from "@pi-cloud/database";
import {
  SKILL_ENVELOPE_BYTES,
  CLOUD_TOOL_NAMES,
  effectiveToolCapabilities,
  parseCloudToolCapabilitySnapshot,
  parseExecutionTargetGrants,
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
  runtime_metadata: SkillVersion["runtimeMetadata"] | null;
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
  runtimeMetadata: row.runtime_metadata!,
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
      maximumDepth?: number | null;
    },
  ) {}

  async publish(
    actor: Actor,
    input: Omit<SkillImport, "label"> & { label?: string },
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
        await sql<VersionRow>`insert into skill_versions(id,tenant_id,package_id,digest,object_key,byte_length,label,description,compatibility,requirements,source,runtime_metadata)
        values(${randomUUID()}::uuid,${actor.tenantId}::uuid,${pack.id}::uuid,${digest},${key},${parsed.byteLength},${input.label ?? `sha-${digest.slice(0, 12)}`},${parsed.description},${parsed.compatibility},${JSON.stringify(requirements)}::jsonb,${JSON.stringify(imported.source)}::jsonb,${JSON.stringify(parsed.runtimeMetadata)}::jsonb)
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

  /** An admitted root Run carries member-level mutation authority, never an
   * implicit organization-owner installation grant. */
  async runActor(
    tenantId: string,
    runId: string,
    root?: { sessionId: string; conversationId: number },
  ): Promise<Actor> {
    const { rows } = await sql<{ userId: string }>`select s.created_by_user_id as "userId"
      from runs r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
      where r.tenant_id=${tenantId}::uuid and r.id=${runId}::uuid
        and (${root?.sessionId ?? null}::uuid is null or (r.session_id=${root?.sessionId ?? null}::uuid and s.pi_conversation_id=${root?.conversationId ?? null}::bigint))`.execute(
      this.options.database,
    );
    if (!rows[0]?.userId) return notFound();
    return { tenantId, userId: rows[0].userId, role: "member" };
  }
  async inspect(tenantId: string, userId: string, name?: string, cursor?: string) {
    const { rows } = await sql<{
      packageId: string;
      name: string;
      owned: boolean;
      versionId: string;
      label: string;
      digest: string;
      description: string;
    }>`
      select p.id as "packageId",p.name,(p.owner_user_id=${userId}::uuid) as owned,
        v.id as "versionId",v.label,v.digest,left(v.description,256) as description
      from skill_packages p cross join lateral
        (select id,label,digest,description from skill_versions where package_id=p.id and tenant_id=p.tenant_id and published order by created_at desc,id desc limit 1) v
      where p.tenant_id=${tenantId}::uuid and (${name ?? null}::text is null or p.name=${name ?? null})
        and (${cursor ?? null}::uuid is null or p.id>${cursor ?? null}::uuid)
      order by p.id limit 21`.execute(this.options.database);
    return { skills: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19]!.packageId : null };
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
            availability: skillAvailability(
              value.requirements,
              effectiveToolCapabilities(
                {
                  sessionKind: "conversation",
                  toolCapabilities: CLOUD_TOOL_NAMES,
                  depth: 0,
                  maximumDepth: this.options.maximumDepth ?? null,
                },
                this.options.catalog?.() ?? [],
              ),
            ),
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
  async runCapabilities(tenantId: string, runId: string, conversationId?: number) {
    const row = (
      await sql<{
        sessionKind: "conversation" | "subagent";
        tools: unknown;
        targets: unknown;
        depth: number;
      }>`select s.session_kind as "sessionKind",
      case when s.id=r.session_id then r.tool_capability_snapshot else s.tool_capabilities end as tools,
      case when s.id=r.session_id then r.execution_target_snapshot else '[]'::jsonb end as targets,
      coalesce(e.depth,0)::int as depth
      from runs r join sessions root on root.tenant_id=r.tenant_id and root.id=r.session_id
      join sessions s on s.tenant_id=root.tenant_id and s.pi_session_id=root.pi_session_id and s.pruned_at is null
      left join subagent_executions e on e.tenant_id=s.tenant_id and e.child_session_id=s.id and e.root_run_id=r.id
      where r.tenant_id=${tenantId}::uuid and r.id=${runId}::uuid
        and ${conversationId === undefined ? sql`s.id=r.session_id` : sql`s.pi_conversation_id=${String(conversationId)}::bigint`}
        and (s.id=r.session_id or e.id is not null)
    `.execute(this.options.database)
    ).rows[0];
    if (!row) return notFound();
    return effectiveToolCapabilities(
      {
        sessionKind: row.sessionKind,
        toolCapabilities: parseCloudToolCapabilitySnapshot(row.tools),
        executionTargets: parseExecutionTargetGrants(row.targets),
        depth: row.depth,
        maximumDepth: this.options.maximumDepth ?? null,
      },
      this.options.catalog?.() ?? [],
    );
  }
  async runCatalog(tenantId: string, runId: string): Promise<SkillVersion[]> {
    return readRunSkillCatalog(this.options.database, tenantId, runId);
  }
  /** One-time derived metadata migration; completed before control readiness. */
  async initialize(): Promise<void> {
    for (;;) {
      const { rows } = await sql<{
        tenant_id: string;
        id: string;
      }>`select tenant_id,id from skill_versions
        where published and runtime_metadata is null order by id limit 30`.execute(
        this.options.database,
      );
      if (!rows.length) return;
      for (const row of rows) {
        const content = await this.content(row.tenant_id, row.id, AbortSignal.timeout(120000));
        const metadata = skillPackage(content.files).runtimeMetadata;
        await sql`update skill_versions set runtime_metadata=${JSON.stringify(metadata)}::jsonb
          where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid and runtime_metadata is null`.execute(
          this.options.database,
        );
      }
    }
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
