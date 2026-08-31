import type { Database } from "@pi-cloud/database";
import type {
  ModelConfigurationResource,
  ProviderModelSelection,
  ReplaceModelConfigurationRequest,
} from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

export class TenantModelConfigurationError extends Error {
  readonly code: "authorization_denied" | "model_configuration_unavailable";

  constructor(code: TenantModelConfigurationError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantModelConfigurationError";
    this.code = code;
  }
}

export type TenantModelConfigurationServiceOptions = {
  database: Kysely<Database>;
  clock?: () => Date;
  platformOperatorTenantId?: string;
  platformModelSourceTenantId?: string;
};

function positiveVersion(value: string | number | bigint): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TenantModelConfigurationError(
      "model_configuration_unavailable",
      "Persisted model route version is invalid",
    );
  }
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TenantModelConfigurationError(
      "model_configuration_unavailable",
      "Persisted model configuration timestamp is invalid",
    );
  }
  return parsed.toISOString();
}

function validClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError("Tenant model configuration clock must return a valid Date");
  }
  return now;
}

function providerModel(provider: string, modelId: string): ProviderModelSelection | undefined {
  if (
    provider === "deepseek" &&
    (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro")
  ) {
    return { provider, modelId };
  }
  if (
    provider === "openai-codex" &&
    (modelId === "gpt-5.6-luna" || modelId === "gpt-5.6-terra" || modelId === "gpt-5.6-sol")
  ) {
    return { provider, modelId };
  }
  return undefined;
}

function thinkingPolicy(): {
  defaultThinkingLevel: "off";
  allowedThinkingLevels: readonly (
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  )[];
} {
  return {
    defaultThinkingLevel: "off",
    allowedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  };
}

export class TenantModelConfigurationService {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;
  readonly #platformOperatorTenantId: string | undefined;
  readonly #platformModelSourceTenantId: string | undefined;

  constructor(options: TenantModelConfigurationServiceOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
    this.#platformOperatorTenantId = options.platformOperatorTenantId;
    this.#platformModelSourceTenantId =
      options.platformModelSourceTenantId ?? options.platformOperatorTenantId;
  }

  async get(identity: TenantRequestIdentity): Promise<ModelConfigurationResource> {
    const row = await this.#database
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
        "profile.credential_binding_version as routeVersion",
        "profile.enabled",
        "profile.updated_at as updatedAt",
        "binding.status as routeStatus",
      ])
      .where("policy.tenant_id", "=", identity.tenantId)
      .executeTakeFirst();
    if (row === undefined || !row.enabled || row.routeStatus !== "active") {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Tenant model configuration is unavailable",
      );
    }
    const routeVersion = positiveVersion(row.routeVersion);
    const updatedAt = timestamp(row.updatedAt);
    if (row.provider === "pi-cloud-fake" && row.modelId === "pi-cloud-fake") {
      return {
        mode: "deterministic",
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        configured: false,
        routeVersion,
        updatedAt,
      };
    }
    const selected = providerModel(row.provider, row.modelId);
    if (selected === undefined) {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Tenant model configuration is unsupported",
      );
    }
    return { mode: "real", ...selected, configured: true, routeVersion, updatedAt };
  }

  async replace(
    identity: TenantRequestIdentity,
    request: ReplaceModelConfigurationRequest,
  ): Promise<ModelConfigurationResource> {
    if (identity.role !== "owner") {
      throw new TenantModelConfigurationError(
        "authorization_denied",
        "Only a tenant owner can replace the model route",
      );
    }
    if (
      this.#platformOperatorTenantId !== undefined &&
      identity.tenantId !== this.#platformOperatorTenantId
    ) {
      throw new TenantModelConfigurationError(
        "authorization_denied",
        "Model configuration is managed by the platform operator",
      );
    }
    const now = validClock(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      if (
        this.#platformOperatorTenantId !== undefined &&
        this.#platformModelSourceTenantId !== undefined
      ) {
        const result = await this.#replaceForTenant(
          transaction,
          this.#platformModelSourceTenantId,
          request,
          now,
        );
        const managedTenants = await transaction
          .selectFrom("user_password_credentials")
          .select("tenant_id as tenantId")
          .distinct()
          .where("tenant_id", "!=", this.#platformModelSourceTenantId)
          .orderBy("tenant_id", "asc")
          .execute();
        for (const managedTenant of managedTenants) {
          await this.#replaceForTenant(transaction, managedTenant.tenantId, request, now);
        }
        return result;
      }
      return this.#replaceForTenant(transaction, identity.tenantId, request, now);
    });
  }

  async #replaceForTenant(
    transaction: Transaction<Database>,
    tenantId: string,
    request: ReplaceModelConfigurationRequest,
    now: Date,
  ): Promise<ModelConfigurationResource> {
    const policy = await transaction
      .selectFrom("tenant_runtime_policies")
      .select(["default_model_profile_id as profileId", "enabled"])
      .where("tenant_id", "=", tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (policy === undefined || !policy.enabled) {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Tenant model configuration is unavailable",
      );
    }
    const profile = await transaction
      .selectFrom("model_profiles")
      .select([
        "id",
        "provider",
        "model_id as modelId",
        "credential_binding_id as routeBindingId",
        "credential_binding_version as routeVersion",
        "updated_at as updatedAt",
        "enabled",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", policy.profileId)
      .executeTakeFirst();
    if (profile === undefined || !profile.enabled) {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Tenant model configuration is unavailable",
      );
    }
    const currentVersion = positiveVersion(profile.routeVersion);
    if (profile.provider === request.provider && profile.modelId === request.modelId) {
      return {
        mode: "real",
        ...request,
        configured: true,
        routeVersion: currentVersion,
        updatedAt: timestamp(profile.updatedAt),
      };
    }
    const maximum = await transaction
      .selectFrom("credential_bindings")
      .select((expression) => expression.fn.max("version").as("maximumVersion"))
      .where("tenant_id", "=", tenantId)
      .where("id", "=", profile.routeBindingId)
      .executeTakeFirstOrThrow();
    const nextVersion = positiveVersion(maximum.maximumVersion ?? currentVersion) + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw new TenantModelConfigurationError(
        "model_configuration_unavailable",
        "Model route version capacity is exhausted",
      );
    }
    const thinking = thinkingPolicy();
    await transaction
      .insertInto("credential_bindings")
      .values({
        id: profile.routeBindingId,
        tenant_id: tenantId,
        provider: request.provider,
        kind: "brokered",
        secret_ref: `provider-gateway://${request.provider}/${request.modelId}`,
        version: nextVersion,
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("model_profiles")
      .set({
        provider: request.provider,
        model_id: request.modelId,
        default_thinking_level: thinking.defaultThinkingLevel,
        allowed_thinking_levels: [...thinking.allowedThinkingLevels],
        credential_binding_id: profile.routeBindingId,
        credential_binding_version: nextVersion,
        enabled: true,
        updated_at: now,
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", profile.id)
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("model_rates")
      .values({
        tenant_id: tenantId,
        provider: request.provider,
        model_id: request.modelId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    return {
      mode: "real",
      ...request,
      configured: true,
      routeVersion: nextVersion,
      updatedAt: now.toISOString(),
    };
  }
}
