import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersistentVolumeWorkspaceVolumeGateway } from "../../src/persistent-volume-workspace-volume-gateway.ts";
import type { PersistentVolumeWorkspaceVolumeGatewayOptions } from "../../src/workspace-volume-gateway-contract.ts";

/** Filesystem transport fixtures inject an explicit quota authority. Real kernel
 * enforcement is exercised by the owned XFS/guest contract, never inferred here. */
export class TestQuotaVolumeGateway extends PersistentVolumeWorkspaceVolumeGateway {
  constructor(
    options: Omit<PersistentVolumeWorkspaceVolumeGatewayOptions, "quota"> &
      Partial<Pick<PersistentVolumeWorkspaceVolumeGatewayOptions, "quota">>,
  ) {
    super({
      ...options,
      quota: options.quota ?? {
        ensure: async (identity) => {
          await writeFile(
            join(
              options.workspaceRoot,
              `picloud-posix-${identity.volumeId}`,
              ".pi-cloud-runtime",
              "quota-enforced-v1",
            ),
            JSON.stringify({ ...identity, version: 1, projectId: 1001, filesystemId: "fixture" }),
          );
        },
        defer: async () => {},
        release: async () => {},
      },
    });
  }
}
