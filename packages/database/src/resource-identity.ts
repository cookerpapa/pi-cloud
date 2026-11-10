import { createHash } from "node:crypto";

/** Canonical identity encoding shared by resource registration and valuation.
 * Provider aliases and quantities are metadata, never part of tenant ownership. */
export function resourceIdentityHash(resource: {
  kind: string;
  resourceId: string;
  tenantId: string;
  workspaceId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: resource.kind,
        resourceId: resource.resourceId,
        tenantId: resource.tenantId,
        workspaceId: resource.workspaceId,
      }),
    )
    .digest("hex");
}
