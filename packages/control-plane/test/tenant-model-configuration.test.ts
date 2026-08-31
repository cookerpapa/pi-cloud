import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TenantModelConfigurationError,
  TenantModelConfigurationService,
  PublicTenantRegistrationService,
  createControlPlaneApplication,
  createPrivateTenant,
  type PrivateTenantInitialModel,
  type TenantRequestIdentity,
} from "../src/index.ts";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
});

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

function ownerIdentity(
  tenant: Awaited<ReturnType<typeof createPrivateTenant>>,
): TenantRequestIdentity {
  return {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: `${tenant.tenantSlug} owner`,
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
}

describe.sequential("tenant model configuration", () => {
  it("persists only a non-secret Provider Gateway route and supports native provider protocols", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "model-route-tenant",
      ownerDisplayName: "Model Route Tenant",
    });
    const identity = ownerIdentity(tenant);
    const service = new TenantModelConfigurationService({ database });

    await expect(service.get(identity)).resolves.toMatchObject({
      mode: "deterministic",
      configured: false,
      routeVersion: 1,
    });
    await expect(
      service.replace(identity, { provider: "openai-codex", modelId: "gpt-5.6-terra" }),
    ).resolves.toMatchObject({
      mode: "real",
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      routeVersion: 2,
    });
    await expect(
      service.replace(identity, { provider: "openai-codex", modelId: "gpt-5.6-terra" }),
    ).resolves.toMatchObject({ routeVersion: 2 });
    await expect(
      service.replace(identity, { provider: "deepseek", modelId: "deepseek-v4-pro" }),
    ).resolves.toMatchObject({ provider: "deepseek", routeVersion: 3 });

    const bindings = await database
      .selectFrom("credential_bindings")
      .select(["provider", "kind", "secret_ref as route"])
      .where("tenant_id", "=", tenant.tenantId)
      .orderBy("version", "asc")
      .execute();
    expect(bindings.slice(-2)).toEqual([
      {
        provider: "openai-codex",
        kind: "brokered",
        route: "provider-gateway://openai-codex/gpt-5.6-terra",
      },
      {
        provider: "deepseek",
        kind: "brokered",
        route: "provider-gateway://deepseek/deepseek-v4-pro",
      },
    ]);
    expect(JSON.stringify(bindings)).not.toMatch(/access_token|refresh_token|api[_-]?key/i);

    await expect(
      service.replace(
        { ...identity, role: "member" },
        { provider: "deepseek", modelId: "deepseek-v4-flash" },
      ),
    ).rejects.toBeInstanceOf(TenantModelConfigurationError);
  });

  it("propagates the platform route to existing managed tenants", async () => {
    const source = await createPrivateTenant(database, {
      slug: "platform-model-source",
      ownerDisplayName: "Platform Model Source",
    });
    const managed = await createPrivateTenant(database, {
      slug: "platform-model-managed",
      ownerDisplayName: "Platform Model Managed",
      webAccount: {
        username: "platform-model-managed",
        role: "owner",
        passwordSalt: "s".repeat(22),
        passwordHash: "h".repeat(43),
        scryptN: 16_384,
        scryptR: 8,
        scryptP: 1,
      },
    });
    const service = new TenantModelConfigurationService({
      database,
      platformOperatorTenantId: source.tenantId,
      platformModelSourceTenantId: source.tenantId,
    });
    await service.replace(ownerIdentity(source), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    await expect(service.get(ownerIdentity(managed))).resolves.toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
  });

  it("resolves the current platform route for every API registration", async () => {
    let initialModel: PrivateTenantInitialModel = {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    };
    const registration = new PublicTenantRegistrationService({
      database,
      enabled: true,
      maximumTenants: 1_000,
      tenantQuotas: { maximumProjects: 2, maximumSessions: 4 },
      initialModel: () => initialModel,
    });
    const first = await registration.register({
      tenantSlug: "dynamic-route-first",
      displayName: "Dynamic Route First",
    });
    initialModel = { provider: "openai-codex", modelId: "gpt-5.6-terra" };
    const second = await registration.register({
      tenantSlug: "dynamic-route-second",
      displayName: "Dynamic Route Second",
    });
    const profiles = await database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select(["policy.tenant_id as tenantId", "profile.provider", "profile.model_id as modelId"])
      .where("policy.tenant_id", "in", [first.tenantId, second.tenantId])
      .orderBy("profile.provider", "asc")
      .execute();
    expect(profiles).toEqual([
      {
        tenantId: first.tenantId,
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      },
      {
        tenantId: second.tenantId,
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
      },
    ]);
  });

  it("exposes route metadata without accepting provider credentials over HTTP", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "model-route-http",
      ownerDisplayName: "Model Route HTTP",
    });
    const application = await createControlPlaneApplication({
      database,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    try {
      await application.listen(0, "127.0.0.1");
      const baseUrl = await application.getUrl();
      const replaced = await fetch(`${baseUrl}/v1/model-configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai-codex", modelId: "gpt-5.6-luna" }),
      });
      expect(replaced.status).toBe(200);
      expect(await replaced.json()).toMatchObject({
        mode: "real",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        routeVersion: 2,
      });
      const rejected = await fetch(`${baseUrl}/v1/model-configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          modelId: "deepseek-v4-flash",
          apiKey: "must-not-enter-picloud",
        }),
      });
      expect(rejected.status).toBe(400);
    } finally {
      await application.close();
    }
  });
});
