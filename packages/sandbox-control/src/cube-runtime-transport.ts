import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { OfficialCubeSandboxRuntimeClient } from "./cubesandbox-runtime-client.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import type { SandboxControlConfig } from "./sandbox-control-config.ts";

/** Each process owns its transport clients; only management receives lifecycle consumers. */
export async function createCubeRuntimeTransport(config: SandboxControlConfig) {
  const cube = config.cubeSandbox;
  const client = new OfficialCubeSandboxRuntimeClient({
    apiUrl: cube.apiUrl,
    apiKey: cube.apiKey,
    executionEndpoints: cube.executionEndpoints,
    proxyNodeIp: cube.proxyNodeIp,
    proxyPort: cube.proxyPort,
    proxyScheme: cube.proxyScheme,
    sandboxDomain: cube.sandboxDomain,
    egressProxyIp: cube.egressProxyHost,
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
      retentionWindowMs: config.elasticRetentionMs,
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
