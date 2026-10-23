import { sql, type Transaction } from "kysely";
import type { Database } from "./database-types.ts";

/** One project serializes image-version publication; ordinary matching reads share it. */
export async function environmentForImage(
  transaction: Transaction<Database>,
  options: {
    tenantId: string;
    projectId: string;
    imageRevision: string;
    id(): string;
  },
) {
  const selection = transaction
    .selectFrom("environment_versions as environment")
    .select([
      "environment.id as environmentVersionId",
      "environment.version_number as environmentVersionNumber",
      "environment.profile_key as environmentProfileKey",
      "environment.profile_version as environmentProfileVersion",
      "environment.image_revision as environmentImageRevision",
      "environment.spec_sha256 as environmentSpecSha256",
      "environment.recipe as environmentRecipe",
      "environment.recipe_sha256 as environmentRecipeSha256",
      "environment.state as environmentState",
      "environment.active as environmentActive",
      "environment.created_at as environmentCreatedAt",
      "environment.validated_at as environmentValidatedAt",
    ])
    .where("environment.tenant_id", "=", options.tenantId)
    .where("environment.project_id", "=", options.projectId)
    .where("environment.active", "=", true);
  let active = await selection
    .where("environment.image_revision", "=", options.imageRevision)
    .forShare()
    .executeTakeFirst();
  if (!active) {
    const project = await transaction
      .selectFrom("projects")
      .select("id")
      .where("tenant_id", "=", options.tenantId)
      .where("id", "=", options.projectId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!project) return { status: "missing" as const };
    active = await selection.forUpdate().executeTakeFirst();
  }
  if (!active) return { status: "missing" as const };
  if (active.environmentState === "failed") return { status: "failed" as const };
  if (active.environmentImageRevision === options.imageRevision)
    return { status: "ready" as const, row: active };
  await transaction
    .updateTable("environment_versions")
    .set({ active: false, updated_at: sql<Date>`now()` })
    .where("id", "=", active.environmentVersionId)
    .where("tenant_id", "=", options.tenantId)
    .executeTakeFirstOrThrow();
  const created = await transaction
    .insertInto("environment_versions")
    .values({
      id: options.id(),
      tenant_id: options.tenantId,
      project_id: options.projectId,
      version_number: Number(active.environmentVersionNumber) + 1,
      profile_key: active.environmentProfileKey,
      profile_version: active.environmentProfileVersion,
      image_revision: options.imageRevision,
      spec_sha256: active.environmentSpecSha256,
      recipe: active.environmentRecipe,
      recipe_sha256: active.environmentRecipeSha256,
      state: "pending",
      active: true,
      validated_at: null,
    })
    .returning([
      "id as environmentVersionId",
      "version_number as environmentVersionNumber",
      "profile_key as environmentProfileKey",
      "profile_version as environmentProfileVersion",
      "image_revision as environmentImageRevision",
      "spec_sha256 as environmentSpecSha256",
      "recipe as environmentRecipe",
      "recipe_sha256 as environmentRecipeSha256",
      "state as environmentState",
      "active as environmentActive",
      "created_at as environmentCreatedAt",
      "validated_at as environmentValidatedAt",
    ])
    .executeTakeFirstOrThrow();
  return { status: "ready" as const, row: created };
}
