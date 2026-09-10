import { createHash } from "node:crypto";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  canonicalEnvironmentRecipeJson,
  parseEnvironmentRecipe,
  type EnvironmentRuntimeSnapshot,
  type WorkspaceSourceResource,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
export type EnvironmentVersionRow = {
  environmentVersionId: string;
  environmentVersionNumber: number;
  environmentProfileKey: string;
  environmentProfileVersion: string;
  environmentImageRevision: string;
  environmentSpecSha256: string;
  environmentRecipe: unknown;
  environmentRecipeSha256: string;
  environmentState: "pending" | "validated" | "failed";
  environmentActive: boolean;
  environmentCreatedAt: Date | string;
  environmentValidatedAt: Date | string | null;
};

export function environmentSnapshot(row: EnvironmentVersionRow): EnvironmentRuntimeSnapshot {
  const recipe = parseEnvironmentRecipe(row.environmentRecipe);
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(recipe))
    .digest("hex");
  if (
    row.environmentProfileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
    row.environmentProfileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
    row.environmentSpecSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
    row.environmentRecipeSha256 !== recipeSha256
  ) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Project environment metadata is invalid",
    );
  }
  return {
    environmentVersionId: row.environmentVersionId,
    versionNumber: row.environmentVersionNumber,
    profileKey: row.environmentProfileKey,
    profileVersion: row.environmentProfileVersion,
    imageRevision: row.environmentImageRevision,
    specSha256: row.environmentSpecSha256,
    recipe,
    recipeSha256: row.environmentRecipeSha256,
  };
}

export function workspaceSourceResource(seedKind: string): WorkspaceSourceResource {
  if (seedKind === "empty" || seedKind === "sample_java") {
    return { kind: seedKind, status: "ready" };
  }
  throw new ControlPlaneStoreError("control_plane_misconfigured", "Workspace seed is invalid");
}

export function isoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Database returned an invalid timestamp",
    );
  }
  return timestamp.toISOString();
}

export function positiveSafeInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a positive safe integer`,
    );
  }
  return parsed;
}

export function nonNegativeSafeInteger(
  value: string | number | bigint,
  description: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a non-negative safe integer`,
    );
  }
  return parsed;
}
