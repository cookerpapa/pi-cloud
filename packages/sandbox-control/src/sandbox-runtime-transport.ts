import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { OfficialCubeSandboxRuntimeClient } from "./cubesandbox-runtime-client.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import type { SandboxRuntimeTransportConfig } from "./sandbox-control-config.ts";
import { lookup } from "node:dns/promises";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { cubeConnectionResolver } from "./cube-connection-capsules.ts";
import { BoxLiteRuntimeClient } from "./boxlite-runtime-client.ts";
import { BoxLiteSandboxProvider } from "./boxlite-sandbox-provider.ts";

/** Each process owns its transport clients; only management receives lifecycle consumers. */
export async function createSandboxRuntimeTransport(
  config: SandboxRuntimeTransportConfig,
  database: Kysely<Database>,
  role: "execution" | "management",
  selectTemplate?: (spec: import("./sandbox-provider.ts").SandboxCreateSpec) => Promise<string>,
) {
  let volume: HttpWorkspaceVolumeGateway | undefined;
  let boxlite: BoxLiteRuntimeClient | undefined;
  let client: OfficialCubeSandboxRuntimeClient | undefined;
  try {
    volume = new HttpWorkspaceVolumeGateway({
      baseUrl: config.storage.url,
      serviceToken: config.storage.token,
      requestTimeoutMs: config.storage.requestTimeoutMs,
    });

    if (config.runtimeProvider === "boxlite") {
      if (!config.boxlite) throw new Error("BoxLite provider configuration is missing");
      boxlite = new BoxLiteRuntimeClient({
        url: config.boxlite.url,
        nodeId: config.boxlite.nodeId,
        token: config.serviceToken,
      });
      const provider = new BoxLiteSandboxProvider({
        runtimeClient: boxlite,
        ...(selectTemplate ? { selectTemplate } : {}),
        ...(role === "management"
          ? {
              templateId: config.boxlite.templateId,
              developmentTemplateIds: config.boxlite.developmentTemplateIds,
            }
          : {}),
        imageRevision: config.imageRevision,
        persistentStateKey: config.persistentStateKey,
        webProxy: {
          host: config.webProxy.host,
          port: config.webProxy.port,
          directPrivateCidrs: [...config.webProxy.directPrivateCidrs],
        },
        workspaceVolumeGateway: volume,
        workspacePersistence: volume.persistence,
      });
      return {
        client: boxlite,
        volume,
        provider,
        persistence: volume.persistence,
        unregisterWorkspaceVolume: async (_id: string) => {},
      };
    }

    const cube = config.cubeSandbox;
    if (!cube) throw new Error("Cube provider configuration is missing");
    const completion = new URL(
      process.env.PI_CLOUD_TOOL_COMPLETION_URL ?? "https://tool-completion:4320/v1/completions",
    );
    const completionIp = (await lookup(completion.hostname, { family: 4 })).address;
    client = new OfficialCubeSandboxRuntimeClient({
      resolveExecutionConnection: cubeConnectionResolver(database, config.persistentStateKey),
      ...(cube.lifecycleRedisPassword
        ? { lifecycleRedisPassword: cube.lifecycleRedisPassword }
        : {}),
      ...(cube.lifecycleRedisUrl ? { lifecycleRedisUrl: cube.lifecycleRedisUrl } : {}),
      apiUrl: cube.apiUrl,
      apiKey: cube.apiKey,
      executionEndpoints: cube.executionEndpoints,
      proxyNodeIp: cube.proxyNodeIp,
      proxyPort: cube.proxyPort,
      proxyScheme: cube.proxyScheme,
      sandboxDomain: cube.sandboxDomain,
      egressProxyIp: config.webProxy.host,
      completionIp,
      directPrivateCidrs: [...config.webProxy.directPrivateCidrs],
      requestTimeoutMs: cube.requestTimeoutMs,
    });

    const provider = new CubeSandboxProvider({
      ...(role === "management"
        ? { templateId: cube.templateId, developmentTemplateIds: cube.developmentTemplateIds }
        : {}),
      imageRevision: config.imageRevision,
      persistentStateKey: config.persistentStateKey,
      runtimeClient: client,
      ...(selectTemplate ? { selectTemplate } : {}),
      webProxy: {
        host: config.webProxy.host,
        port: config.webProxy.port,
        directPrivateCidrs: [...config.webProxy.directPrivateCidrs],
      },
      workspaceVolumeGateway: volume,
      workspacePersistence: volume.persistence,
    });

    const registrations = client;
    return {
      client,
      volume,
      provider,
      persistence: volume.persistence,
      unregisterWorkspaceVolume: (id: string) => registrations.deleteVolume(id),
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      boxlite ? boxlite.close() : client?.close(),
      volume?.close(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError([error, ...failures], "Provider transport startup failed", {
        cause: error,
      });
    throw error;
  }
}
