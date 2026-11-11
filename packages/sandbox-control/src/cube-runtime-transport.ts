import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { OfficialCubeSandboxRuntimeClient } from "./cubesandbox-runtime-client.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import type { SandboxControlConfig } from "./sandbox-control-config.ts";
import { lookup } from "node:dns/promises";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { cubeConnectionResolver } from "./cube-connection-capsules.ts";

/** Each process owns its transport clients; only management receives lifecycle consumers. */
export async function createCubeRuntimeTransport(
  config: SandboxControlConfig,
  database: Kysely<Database>,
) {
  const cube = config.cubeSandbox;
  const completion = new URL(
    process.env.PI_CLOUD_TOOL_COMPLETION_URL ?? "https://tool-completion:4320/v1/completions",
  );
  const completionIp = (await lookup(completion.hostname, { family: 4 })).address;
  const client = new OfficialCubeSandboxRuntimeClient({
    resolveExecutionConnection: cubeConnectionResolver(database, config.persistentStateKey),
    ...(cube.lifecycleRedisPassword ? { lifecycleRedisPassword: cube.lifecycleRedisPassword } : {}),
    ...(cube.lifecycleRedisUrl ? { lifecycleRedisUrl: cube.lifecycleRedisUrl } : {}),
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
  try {
    volume = new HttpWorkspaceVolumeGateway({
      baseUrl: cube.workspaceVolumeGatewayUrl,
      serviceToken: cube.workspaceVolumeGatewayToken,
      requestTimeoutMs: cube.workspaceVolumeGatewayRequestTimeoutMs,
    });

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
    const cleanup = await Promise.allSettled([client.close(), volume?.close()]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError([error, ...failures], "Cube transport startup failed", {
        cause: error,
      });
    throw error;
  }
}
