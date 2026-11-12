import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parsePutResourceBackend,
  parseResourceBackendConfiguration,
  type PutResourceBackend,
  type ResourceBackendConfiguration,
  type ResourceBackendResource,
} from "@pi-cloud/protocol";
import { CubePersistentCapsuleCodec } from "./cube-persistent-capsule.ts";

export type ResourceBackend = {
  resource: ResourceBackendResource;
  configuration: ResourceBackendConfiguration;
};
export const backendEndpoint = (config: ResourceBackendConfiguration) =>
  new URL(
    config.compute.provider === "boxlite" ? config.compute.url : config.compute.apiUrl,
  ).toString();

export function resourceBackendCatalog(
  input: Omit<PutResourceBackend, "expectedRevision" | "configuration">,
  config: ResourceBackendConfiguration,
  revision: number,
): ResourceBackendResource {
  return {
    id: input.id,
    name: input.name,
    location: input.location,
    state: input.state,
    revision,
    provider: config.compute.provider,
    templates: config.templates.map(({ id, name, operatingSystem, imageRevision }) => ({
      id,
      name,
      operatingSystem,
      imageRevision,
      profiles: ["starter", "standard", "performance"],
    })),
    capabilities: { kind: "linux", workspace: "independent-volume", terminal: true, preview: true },
  };
}

function openBackendConfiguration(
  codec: CubePersistentCapsuleCodec,
  id: string,
  sealed: string,
): ResourceBackendConfiguration {
  const value = codec.open(sealed) as {
    kind?: string;
    id?: string;
    configuration?: unknown;
  };
  if (value.kind !== "resource-backend-v1" || value.id !== id)
    throw new Error("Backend credential identity changed");
  return parseResourceBackendConfiguration(value.configuration);
}
export async function readResourceBackends(
  database: Kysely<Database>,
  codec: CubePersistentCapsuleCodec,
): Promise<readonly ResourceBackend[]> {
  const rows = await database
    .selectFrom("sandbox_domains")
    .select(["id", "backend_catalog", "backend_configuration"])
    .where("backend_revision", ">", "0")
    .orderBy("id")
    .execute();
  return rows.map((row) => {
    if (!row.backend_configuration || !row.backend_catalog)
      throw new Error("Backend configuration is incomplete");
    return {
      resource: row.backend_catalog as unknown as ResourceBackendResource,
      configuration: openBackendConfiguration(codec, row.id, row.backend_configuration),
    };
  });
}

/** Private registry. Public API code only sees the separately stored catalog. */
export class ResourceBackendRegistry {
  readonly #codec: CubePersistentCapsuleCodec;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      key: Uint8Array;
      managementBaseUrl: string;
      verify(configuration: ResourceBackendConfiguration): Promise<string>;
    },
  ) {
    this.#codec = new CubePersistentCapsuleCodec(options.key);
  }

  #open(id: string, sealed: string) {
    return openBackendConfiguration(this.#codec, id, sealed);
  }
  list() {
    return readResourceBackends(this.options.database, this.#codec);
  }
  async #assertUnused(tx: Transaction<Database>, id: string, templatesOnly = false) {
    const used =
      await sql`select 1 from workspaces where sandbox_domain_id=${id} and storage_purged_at is null and not ${templatesOnly}
      union all select 1 from workspace_runtimes where sandbox_domain_id=${id} and state<>'released'
      union all select 1 from development_environments where sandbox_domain_id=${id} and (not allocation_absent or not allocation_closed)
      union all select 1 from workspace_terminal_sessions where sandbox_domain_id=${id} and state<>'released' limit 1`.execute(
        tx,
      );
    if (used.rows.length)
      throw new Error("Backend connection changes require all retained resources to be released");
  }
  async put(value: unknown): Promise<ResourceBackendResource> {
    const input = parsePutResourceBackend(value);
    const before = await this.options.database
      .selectFrom("sandbox_domains")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    const previous = before?.backend_configuration
      ? this.#open(input.id, before.backend_configuration)
      : undefined;
    let config = input.configuration ?? previous;
    if (!config) throw new Error("New backend requires its configuration");
    const changed = !isDeepStrictEqual(config, previous);
    if (changed || input.state === "active") {
      const poolId = await this.options.verify(config);
      config = { ...config, storage: { ...config.storage, poolId } };
    }
    if (!config.storage.poolId) throw new Error("Backend storage identity is unconfirmed");
    const accepted = config;
    return this.options.database.transaction().execute(async (tx) => {
      const config = accepted;
      // Serialize creation of a previously absent id, without a second queue.
      await sql`select pg_advisory_xact_lock(hashtextextended(${"resource-backend:" + input.id}, 0))`.execute(
        tx,
      );
      const row = await tx
        .selectFrom("sandbox_domains")
        .selectAll()
        .where("id", "=", input.id)
        .forUpdate()
        .executeTakeFirst();
      const revision = Number(row?.backend_revision ?? 0);
      const current = row?.backend_configuration
        ? this.#open(input.id, row.backend_configuration)
        : undefined;
      if (
        row?.backend_catalog &&
        isDeepStrictEqual(resourceBackendCatalog(input, config, revision), row.backend_catalog) &&
        isDeepStrictEqual(config, current) &&
        (input.expectedRevision === revision || input.expectedRevision + 1 === revision)
      )
        return row.backend_catalog as unknown as ResourceBackendResource;
      if (revision !== input.expectedRevision)
        throw new Error("Backend revision changed; refresh before saving");
      if (current && !isDeepStrictEqual(current, config)) {
        const { templates: priorTemplates, ...priorConnection } = current;
        const { templates: nextTemplates, ...nextConnection } = config;
        const executionTemplate = ({
          name: _name,
          operatingSystem: _os,
          ...template
        }: ResourceBackendConfiguration["templates"][number]) => template;
        const additionOnly =
          isDeepStrictEqual(priorConnection, nextConnection) &&
          priorTemplates.every((template) =>
            nextTemplates.some((next) =>
              isDeepStrictEqual(executionTemplate(template), executionTemplate(next)),
            ),
          );
        if (!additionOnly)
          await this.#assertUnused(
            tx,
            input.id,
            isDeepStrictEqual(priorConnection, nextConnection),
          );
      }
      const resource = resourceBackendCatalog(input, config, revision + 1);
      const values = {
        display_name: input.name,
        state: input.state,
        backend_location: input.location,
        backend_revision: revision + 1,
        backend_endpoint: backendEndpoint(config),
        backend_configuration: this.#codec.seal({
          kind: "resource-backend-v1",
          id: input.id,
          configuration: config,
        }),
        backend_catalog: resource as unknown as Record<string, unknown>,
        storage_pool_id: config.storage.poolId,
        updated_at: new Date(),
      };
      if (row)
        await tx.updateTable("sandbox_domains").set(values).where("id", "=", input.id).execute();
      else
        await tx
          .insertInto("sandbox_domains")
          .values({
            id: input.id,
            ...values,
            sandbox_control_base_url: this.options.managementBaseUrl,
            workspace_storage_key: config.storage.poolId!,
            maximum_active_sandboxes: null,
          })
          .execute();
      return resource;
    });
  }

  /** One-time adoption of the deployment's initial domain; never overwrites a registered revision. */
  async bootstrap(input: Omit<PutResourceBackend, "expectedRevision">) {
    const existing = await this.options.database
      .selectFrom("sandbox_domains")
      .select("backend_revision")
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (Number(existing?.backend_revision ?? 0) > 0) return;
    await this.put({ ...input, expectedRevision: 0 });
  }
}
