import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { ResourceBackendConfiguration } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import type { SandboxRuntimeTransportConfig } from "./sandbox-control-config.ts";
import { createSandboxRuntimeTransport } from "./sandbox-runtime-transport.ts";
import type { ResourceBackend } from "./resource-backend-registry.ts";

export function backendTransportConfig(
  base: Pick<
    SandboxRuntimeTransportConfig,
    "persistentStateKey" | "imageRevision" | "serviceToken"
  >,
  configuration: ResourceBackendConfiguration,
): SandboxRuntimeTransportConfig {
  const { compute, storage, webProxy, templates } = configuration;
  const first = templates[0]!;
  return {
    ...base,
    runtimeProvider: compute.provider,
    storage: { url: storage.url, token: storage.token, requestTimeoutMs: 660_000 },
    webProxy,
    ...(compute.provider === "boxlite"
      ? {
          serviceToken: compute.token,
          boxlite: {
            url: compute.url,
            nodeId: compute.nodeId,
            templateId: first.elasticTemplateId,
            developmentTemplateIds: first.profiles,
          },
        }
      : {
          cubeSandbox: {
            ...compute,
            executionEndpoints: [],
            templateId: first.elasticTemplateId,
            developmentTemplateIds: first.profiles,
            requestTimeoutMs: 120_000,
          },
        }),
  };
}

export async function verifyResourceBackend(
  database: Kysely<Database>,
  base: Pick<
    SandboxRuntimeTransportConfig,
    "persistentStateKey" | "imageRevision" | "serviceToken"
  >,
  configuration: ResourceBackendConfiguration,
) {
  if (configuration.templates.some((t) => t.imageRevision !== base.imageRevision))
    throw new Error("Backend template uses an unsupported fixed Guest revision");
  const transport = await createSandboxRuntimeTransport(
    backendTransportConfig(base, configuration),
    database,
    "execution",
  );
  try {
    await transport.client.checkHealth();
    await transport.client.list(); // Authenticated native read; public liveness is insufficient.
    const templates = new Set(
      configuration.templates.flatMap((t) => [t.elasticTemplateId, ...Object.values(t.profiles)]),
    );
    const capacities = new Map<
      string,
      { cpuCount: number; memoryMiB: number; systemDiskGiB: number }
    >();
    for (const template of templates)
      capacities.set(template, await transport.client.verifyTemplate(template));
    for (const template of configuration.templates)
      for (const profile of DEVELOPMENT_ENVIRONMENT_PROFILES) {
        const capacity = capacities.get(template.profiles[profile.key])!;
        if (
          capacity.cpuCount !== profile.cpuCount ||
          capacity.memoryMiB !== profile.memoryMiB ||
          capacity.systemDiskGiB !== profile.systemDiskGiB
        )
          throw new Error("Backend template capacity does not match the offered profile");
      }
    const storage = await transport.volume.persistenceInfo();
    if (configuration.storage.poolId && storage.poolId !== configuration.storage.poolId)
      throw new Error("Backend storage pool identity changed");
    return storage.poolId;
  } finally {
    await transport.provider.close();
  }
}

export async function createResourceBackendTransport(
  database: Kysely<Database>,
  base: Pick<
    SandboxRuntimeTransportConfig,
    "persistentStateKey" | "imageRevision" | "serviceToken"
  >,
  backend: ResourceBackend,
  role: "execution" | "management",
  current: () => ResourceBackend = () => backend,
) {
  return createSandboxRuntimeTransport(
    backendTransportConfig(base, backend.configuration),
    database,
    role,
    role === "management"
      ? async (spec) => {
          const workspace = await database
            .selectFrom("workspaces")
            .select(["sandbox_domain_id", "backend_template_id"])
            .where("tenant_id", "=", spec.assignment.tenantId)
            .where("id", "=", spec.assignment.workspaceId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          const active = current();
          if (!workspace || workspace.sandbox_domain_id !== backend.resource.id)
            throw new Error("Workspace backend changed");
          if (workspace.backend_template_id === null) {
            const defaultId = active.configuration.templates[0]!.id;
            await database
              .updateTable("workspaces")
              .set({ backend_template_id: defaultId })
              .where("tenant_id", "=", spec.assignment.tenantId)
              .where("id", "=", spec.assignment.workspaceId)
              .where("sandbox_domain_id", "=", backend.resource.id)
              .where("backend_template_id", "is", null)
              .execute();
            const frozen = await database
              .selectFrom("workspaces")
              .select("backend_template_id")
              .where("id", "=", spec.assignment.workspaceId)
              .where("tenant_id", "=", spec.assignment.tenantId)
              .executeTakeFirstOrThrow();
            workspace.backend_template_id = frozen.backend_template_id;
          }
          const template = active.configuration.templates.find(
            (t) => t.id === workspace.backend_template_id,
          );
          if (!template) throw new Error("Workspace template is unavailable");
          return spec.sandboxProfileKey
            ? template.profiles[spec.sandboxProfileKey]
            : template.elasticTemplateId;
        }
      : undefined,
  );
}
