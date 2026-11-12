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
) {
  const cube = config.cubeSandbox;
  const completion = new URL(
    process.env.PI_CLOUD_TOOL_COMPLETION_URL ?? "https://tool-completion:4320/v1/completions",
  );
  const completionIp = (await lookup(completion.hostname, { family: 4 })).address;
  const client = new OfficialCubeSandboxRuntimeClient({
    resolveExecutionConnection: cubeConnectionResolver(database, config.persistentStateKey),
    ...(config.runtimeProvider !== "boxlite" && cube.lifecycleRedisPassword
      ? { lifecycleRedisPassword: cube.lifecycleRedisPassword }
      : {}),
    ...(config.runtimeProvider !== "boxlite" && cube.lifecycleRedisUrl
      ? { lifecycleRedisUrl: cube.lifecycleRedisUrl }
      : {}),
    apiUrl: cube.apiUrl,
    apiKey: cube.apiKey,
    executionEndpoints: cube.executionEndpoints,
    proxyNodeIp: cube.proxyNodeIp,
    proxyPort: cube.proxyPort,
    proxyScheme: cube.proxyScheme,
    sandboxDomain: cube.sandboxDomain,
    egressProxyIp: cube.egressProxyHost,
    completionIp,
    directPrivateCidrs: [...cube.directPrivateCidrs],
    requestTimeoutMs: cube.requestTimeoutMs,
  });

  let volume: HttpWorkspaceVolumeGateway | undefined;
  let boxlite: BoxLiteRuntimeClient | undefined;
  try {
    volume = new HttpWorkspaceVolumeGateway({
      baseUrl: cube.workspaceVolumeGatewayUrl,
      serviceToken: cube.workspaceVolumeGatewayToken,
      requestTimeoutMs: cube.workspaceVolumeGatewayRequestTimeoutMs,
    });

    if (config.runtimeProvider === "boxlite") {
      if (!config.boxlite) throw new Error("BoxLite provider configuration is missing");
      boxlite = new BoxLiteRuntimeClient({
        url: config.boxlite.url,
        nodeId: config.boxlite.nodeId,
        token: config.serviceToken,
        volumes: client,
      });
      const provider = new BoxLiteSandboxProvider({
        runtimeClient: boxlite,
        templateId: config.boxlite.templateId,
        developmentTemplateIds: config.boxlite.developmentTemplateIds,
        imageRevision: config.imageRevision,
        persistentStateKey: config.persistentStateKey,
        webProxy: {
          host: cube.egressProxyHost,
          port: cube.egressProxyPort,
          directPrivateCidrs: [...cube.directPrivateCidrs],
        },
        workspaceVolumeGateway: volume,
      });
      return { client: boxlite, volume, provider };
    }

    const provider = new CubeSandboxProvider({
      templateId: cube.templateId,
      developmentTemplateIds: cube.developmentTemplateIds,
      imageRevision: config.imageRevision,
      persistentStateKey: config.persistentStateKey,
      runtimeClient: client,
      webProxy: {
        host: cube.egressProxyHost,
        port: cube.egressProxyPort,
        directPrivateCidrs: [...cube.directPrivateCidrs],
      },
      workspaceVolumeGateway: volume,
    });

    return { client, volume, provider };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      boxlite ? boxlite.close() : client.close(),
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
