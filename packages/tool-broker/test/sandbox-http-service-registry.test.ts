import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresSandboxHttpServiceRegistry } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("PostgreSQL Sandbox HTTP service registry", () => {
  it("upserts one runtime-port identity and ends it when the listener disappears", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());
    await runMigrations(database, "up");

    const tenantId = "40000000-0000-4000-8000-000000000001";
    const projectId = "40000000-0000-4000-8000-000000000002";
    const workspaceId = "40000000-0000-4000-8000-000000000003";
    const credentialId = "40000000-0000-4000-8000-000000000004";
    const profileId = "40000000-0000-4000-8000-000000000005";
    const sessionId = "40000000-0000-4000-8000-000000000006";
    await database.insertInto("tenants").values({ id: tenantId, slug: "service-test" }).execute();
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "service-test" })
      .execute();
    await database
      .insertInto("workspaces")
      .values({
        id: workspaceId,
        tenant_id: tenantId,
        project_id: projectId,
        sandbox_domain_id: "sandbox-domain-0001",
        seed_kind: "empty",
      })
      .execute();
    await database
      .insertInto("credential_bindings")
      .values({
        id: credentialId,
        tenant_id: tenantId,
        provider: "test",
        kind: "api_key",
        secret_ref: "test://service",
        version: 1,
        status: "active",
      })
      .execute();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "service-test",
        provider: "test",
        model_id: "test",
        default_thinking_level: "off",
        allowed_thinking_levels: ["off"],
        credential_binding_id: credentialId,
        credential_binding_version: 1,
      })
      .execute();
    await database
      .insertInto("sessions")
      .values({
        id: sessionId,
        tenant_id: tenantId,
        project_id: projectId,
        workspace_id: workspaceId,
        desired_model_profile_id: profileId,
        state: "idle",
        workspace_settlement_key: null,
      })
      .execute();

    let now = new Date("2026-08-25T00:00:00.000Z");
    const registry = new PostgresSandboxHttpServiceRegistry({
      database,
      clock: () => new Date(now),
    });
    const observation = {
      target: {
        kind: "conversation" as const,
        targetId: sessionId,
        tenantId,
        workspaceId,
        sessionId,
      },
      runtimeId: "runtime-1",
      activationId: "40000000-0000-4000-8000-000000000007",
      operationId: "40000000-0000-4000-8000-000000000008",
      listeningPorts: [3_000],
      httpServices: [{ port: 3_000, protocol: "http" as const }],
    };
    await registry.observe(observation);
    expect(
      await database
        .selectFrom("sandbox_http_services")
        .select(["port", "state", "ended_at"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ port: 3_000, state: "active", ended_at: null });

    now = new Date("2026-08-25T00:01:00.000Z");
    await registry.observe({ ...observation, listeningPorts: [], httpServices: [] });
    expect(
      await database
        .selectFrom("sandbox_http_services")
        .select(["state", "ended_at"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "ended", ended_at: now });

    now = new Date("2026-08-25T00:02:00.000Z");
    await registry.observe(observation);
    const rows = await database
      .selectFrom("sandbox_http_services")
      .select(["state", "ended_at", "last_seen_at"])
      .execute();
    expect(rows).toEqual([{ state: "active", ended_at: null, last_seen_at: now }]);
  }, 20_000);
});
