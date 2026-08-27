import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudPreviewTool } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("trusted Preview Tool", () => {
  it("resolves only a verified active service into an authenticated conversation route", async () => {
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

    const tenantId = "50000000-0000-4000-8000-000000000001";
    const projectId = "50000000-0000-4000-8000-000000000002";
    const workspaceId = "50000000-0000-4000-8000-000000000003";
    const credentialId = "50000000-0000-4000-8000-000000000004";
    const profileId = "50000000-0000-4000-8000-000000000005";
    const sessionId = "50000000-0000-4000-8000-000000000006";
    await database.insertInto("tenants").values({ id: tenantId, slug: "preview-tool" }).execute();
    await database
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "preview-tool" })
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
        secret_ref: "test://preview",
        version: 1,
        status: "active",
      })
      .execute();
    await database
      .insertInto("model_profiles")
      .values({
        id: profileId,
        tenant_id: tenantId,
        name: "preview-tool",
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
        workspace_snapshot_key: null,
      })
      .execute();
    await database
      .insertInto("sandbox_http_services")
      .values({
        id: "50000000-0000-4000-8000-000000000007",
        tenant_id: tenantId,
        target_kind: "conversation",
        target_id: sessionId,
        workspace_id: workspaceId,
        session_id: sessionId,
        development_environment_id: null,
        runtime_id: "runtime-preview",
        activation_id: "50000000-0000-4000-8000-000000000008",
        last_operation_id: "50000000-0000-4000-8000-000000000009",
        port: 3_000,
        protocol: "http",
        state: "active",
        ended_at: null,
      })
      .execute();

    const tool = createCloudPreviewTool({ database, tenantId, sessionId });
    await expect(tool.execute("preview-call", { port: 3_000, path: "/game" })).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          port: 3_000,
          previewPath: `/v1/conversations/${sessionId}/preview/3000/game`,
        }),
      }),
    );
    await database
      .updateTable("sandbox_http_services")
      .set({ state: "ended", ended_at: new Date() })
      .where("tenant_id", "=", tenantId)
      .where("target_id", "=", sessionId)
      .execute();
    await expect(tool.execute("preview-call-2", { port: 3_000 })).rejects.toThrow(
      "preview_service_not_found",
    );
  }, 20_000);
});
