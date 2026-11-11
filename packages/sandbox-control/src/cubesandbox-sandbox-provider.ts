import {
  FixedGuestSandboxProvider,
  FIXED_GUEST_TOOL_POLICY,
} from "./fixed-guest-sandbox-provider.ts";
import {
  OfficialCubeSandboxRuntimeClient,
  type OfficialCubeSandboxRuntimeClientOptions,
  type CubeSandboxRuntimeClient,
  type CubeSandboxInstance,
} from "./cubesandbox-runtime-client.ts";
import type { DevelopmentEnvironmentProfileKey, ToolWebProxyBootstrap } from "@pi-cloud/protocol";
import type { WorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
export const CUBESANDBOX_PROVIDER_ID = "cubesandbox";
export const CUBESANDBOX_RUNTIME_NAME = "cubesandbox-kvm";
export const CUBESANDBOX_TOOL_POLICY = FIXED_GUEST_TOOL_POLICY;
export type CubeSandboxProviderOptions = Readonly<{
  templateId: string;
  developmentTemplateIds: Readonly<Record<DevelopmentEnvironmentProfileKey, string>>;
  imageRevision: string;
  runtimeClient?: CubeSandboxRuntimeClient;
  runtime?: OfficialCubeSandboxRuntimeClientOptions;
  readyTimeoutMs?: number;
  webProxy: ToolWebProxyBootstrap;
  workspaceVolumeGateway: WorkspaceVolumeGateway;
  persistentStateKey?: Uint8Array;
}>;

/** Cube-specific connection authority; all fixed Guest behavior is shared. */
export class CubeSandboxProvider extends FixedGuestSandboxProvider<CubeSandboxInstance> {
  constructor(options: CubeSandboxProviderOptions) {
    const client =
      options.runtimeClient ??
      (options.runtime ? new OfficialCubeSandboxRuntimeClient(options.runtime) : undefined);
    if (!client) throw new TypeError("CubeSandbox runtime configuration is missing");
    super({
      ...options,
      runtimeClient: client,
      providerId: CUBESANDBOX_PROVIDER_ID,
      runtimeName: CUBESANDBOX_RUNTIME_NAME,
      connections: {
        valid: (instance) =>
          typeof instance.trafficAccessToken === "string" &&
          instance.trafficAccessToken.length >= 16,
        merge: (previous, observed) => ({
          ...previous,
          ...observed,
          metadata: previous.metadata,
          ...(previous.trafficAccessToken
            ? { trafficAccessToken: previous.trafficAccessToken }
            : {}),
        }),
      },
    });
  }
}
