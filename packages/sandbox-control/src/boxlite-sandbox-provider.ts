import {
  FixedGuestSandboxProvider,
  type FixedGuestSandboxProviderOptions,
} from "./fixed-guest-sandbox-provider.ts";
import type { BoxLiteInstance } from "./boxlite-node-contract.ts";

export type BoxLiteSandboxProviderOptions = Omit<
  FixedGuestSandboxProviderOptions<BoxLiteInstance>,
  "providerId" | "runtimeName" | "connections"
>;

/** BoxLite uses its own native identities and process evidence. The fixed Guest
 * bootstrap, Workspace files, images and human access are common with Cube. */
export class BoxLiteSandboxProvider extends FixedGuestSandboxProvider<BoxLiteInstance> {
  constructor(options: BoxLiteSandboxProviderOptions) {
    super({
      ...options,
      providerId: "boxlite",
      runtimeName: "boxlite-kvm",
      connections: {
        valid: (instance) =>
          !!instance.attachment &&
          !!instance.connection &&
          instance.connection.processes.length > 0,
        merge: (previous, observed) => ({
          ...previous,
          ...observed,
          metadata: previous.metadata,
          attachment: previous.attachment,
          ...(observed.connection
            ? {}
            : previous.connection
              ? { connection: previous.connection }
              : {}),
        }),
      },
    });
  }
}
