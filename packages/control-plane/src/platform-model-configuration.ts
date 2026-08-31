import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { PrivateTenantInitialModel } from "./tenant-administration.ts";

export class PlatformModelConfigurationError extends Error {
  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "PlatformModelConfigurationError";
  }
}

export async function resolvePlatformInitialModel(
  database: Kysely<Database>,
  sourceTenantId: string,
): Promise<PrivateTenantInitialModel | undefined> {
  const profile = await database
    .selectFrom("tenant_runtime_policies as policy")
    .innerJoin("model_profiles as profile", (join) =>
      join
        .onRef("profile.tenant_id", "=", "policy.tenant_id")
        .onRef("profile.id", "=", "policy.default_model_profile_id"),
    )
    .innerJoin("credential_bindings as binding", (join) =>
      join
        .onRef("binding.tenant_id", "=", "profile.tenant_id")
        .onRef("binding.id", "=", "profile.credential_binding_id")
        .onRef("binding.version", "=", "profile.credential_binding_version"),
    )
    .select([
      "profile.provider",
      "profile.model_id as modelId",
      "profile.enabled",
      "binding.status as routeStatus",
    ])
    .where("policy.tenant_id", "=", sourceTenantId)
    .where("policy.enabled", "=", true)
    .executeTakeFirst();

  if (profile === undefined || !profile.enabled || profile.routeStatus !== "active") {
    throw new PlatformModelConfigurationError("Platform default model is unavailable");
  }
  if (profile.provider === "pi-cloud-fake" && profile.modelId === "pi-cloud-fake") {
    return undefined;
  }
  if (
    profile.provider === "deepseek" &&
    (profile.modelId === "deepseek-v4-flash" || profile.modelId === "deepseek-v4-pro")
  ) {
    return { provider: profile.provider, modelId: profile.modelId };
  }
  if (
    profile.provider === "openai-codex" &&
    (profile.modelId === "gpt-5.6-luna" ||
      profile.modelId === "gpt-5.6-terra" ||
      profile.modelId === "gpt-5.6-sol")
  ) {
    return { provider: profile.provider, modelId: profile.modelId };
  }
  throw new PlatformModelConfigurationError("Platform default model is unsupported");
}
