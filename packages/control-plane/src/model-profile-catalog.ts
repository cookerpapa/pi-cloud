import type { Database } from "@pi-cloud/database";
import type { ModelCatalogEntryResource, ProviderModelSelection } from "@pi-cloud/protocol";
import type { Transaction } from "kysely";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SUPPORTED_MODEL_CATALOG = Object.freeze([
  {
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
  },
  {
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
  },
  {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
  },
] satisfies readonly Omit<ModelCatalogEntryResource, "default">[]);

export function supportedModel(
  selection: ProviderModelSelection,
): (typeof SUPPORTED_MODEL_CATALOG)[number] | undefined {
  return SUPPORTED_MODEL_CATALOG.find(
    (model) => model.provider === selection.provider && model.modelId === selection.modelId,
  );
}

export function supportedModelSelection(
  provider: string,
  modelId: string,
): ProviderModelSelection | undefined {
  const model = SUPPORTED_MODEL_CATALOG.find(
    (candidate) => candidate.provider === provider && candidate.modelId === modelId,
  );
  if (model === undefined) return undefined;
  if (model.provider === "deepseek") {
    return { provider: model.provider, modelId: model.modelId };
  }
  return { provider: model.provider, modelId: model.modelId };
}

export type SelectableModelProfile = Readonly<{
  profileId: string;
  provider: ProviderModelSelection["provider"];
  modelId: ProviderModelSelection["modelId"];
  credentialBindingId: string;
  credentialBindingVersion: number;
  updatedAt: Date | string;
}>;

export async function ensureSelectableModelProfile(options: {
  transaction: Transaction<Database>;
  tenantId: string;
  selection: ProviderModelSelection;
  idGenerator: () => string;
  now: Date;
}): Promise<SelectableModelProfile> {
  if (supportedModel(options.selection) === undefined) {
    throw new TypeError("Model selection is unsupported");
  }
  const existing = await options.transaction
    .selectFrom("model_profiles as profile")
    .innerJoin("credential_bindings as binding", (join) =>
      join
        .onRef("binding.tenant_id", "=", "profile.tenant_id")
        .onRef("binding.id", "=", "profile.credential_binding_id")
        .onRef("binding.version", "=", "profile.credential_binding_version"),
    )
    .select([
      "profile.id as profileId",
      "profile.provider",
      "profile.model_id as modelId",
      "profile.credential_binding_id as credentialBindingId",
      "profile.credential_binding_version as credentialBindingVersion",
      "profile.updated_at as updatedAt",
    ])
    .where("profile.tenant_id", "=", options.tenantId)
    .where("profile.provider", "=", options.selection.provider)
    .where("profile.model_id", "=", options.selection.modelId)
    .where("profile.enabled", "=", true)
    .where("binding.status", "=", "active")
    .orderBy("profile.created_at", "asc")
    .executeTakeFirst();
  if (existing !== undefined) {
    const credentialBindingVersion = Number(existing.credentialBindingVersion);
    if (!Number.isSafeInteger(credentialBindingVersion) || credentialBindingVersion < 1) {
      throw new TypeError("Model profile binding version is invalid");
    }
    return {
      profileId: existing.profileId,
      provider: options.selection.provider,
      modelId: options.selection.modelId,
      credentialBindingId: existing.credentialBindingId,
      credentialBindingVersion,
      updatedAt: existing.updatedAt,
    };
  }

  const profileId = options.idGenerator();
  const credentialBindingId = options.idGenerator();
  await options.transaction
    .insertInto("credential_bindings")
    .values({
      id: credentialBindingId,
      tenant_id: options.tenantId,
      provider: options.selection.provider,
      kind: "brokered",
      secret_ref: `provider-gateway://${options.selection.provider}/${options.selection.modelId}`,
      version: 1,
      status: "active",
      created_at: options.now,
      updated_at: options.now,
    })
    .executeTakeFirstOrThrow();
  await options.transaction
    .insertInto("model_profiles")
    .values({
      id: profileId,
      tenant_id: options.tenantId,
      name: `selectable-${options.selection.provider}-${options.selection.modelId}-${profileId.slice(0, 8)}`,
      provider: options.selection.provider,
      model_id: options.selection.modelId,
      default_thinking_level: "off",
      allowed_thinking_levels: [...THINKING_LEVELS],
      credential_binding_id: credentialBindingId,
      credential_binding_version: 1,
      enabled: true,
      created_at: options.now,
      updated_at: options.now,
    })
    .executeTakeFirstOrThrow();
  await options.transaction
    .insertInto("model_rates")
    .values({
      tenant_id: options.tenantId,
      provider: options.selection.provider,
      model_id: options.selection.modelId,
      created_at: options.now,
      updated_at: options.now,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  return {
    profileId,
    provider: options.selection.provider,
    modelId: options.selection.modelId,
    credentialBindingId,
    credentialBindingVersion: 1,
    updatedAt: options.now,
  };
}
