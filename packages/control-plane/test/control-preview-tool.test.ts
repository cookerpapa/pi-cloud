import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { afterEach, describe, expect, it } from "vitest";
import { executePreviewTool } from "../src/control-preview-tool.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
}, 60_000);

describe("trusted Preview Tool", () => {
  it.each([null, "child-compute"])(
    "routes machine previews according to compute scope %s",
    async (compute) => {
      const filters: unknown[][] = [];
      const database = {
        selectFrom(table: string) {
          const query = {
            select() {
              return query;
            },
            where(...args: unknown[]) {
              if (table === "sandbox_http_services") filters.push(args);
              return query;
            },
            orderBy() {
              return query;
            },
            async executeTakeFirstOrThrow() {
              return { development_environment_id: "parent-machine", compute_session_id: compute };
            },
            async executeTakeFirst() {
              return { id: "service" };
            },
          };
          return query;
        },
      } as unknown as Parameters<typeof executePreviewTool>[0];
      await executePreviewTool(
        database,
        {
          scope: { tenantId: "tenant", sessionId: "child" },
          arguments: { port: 3000 },
        } as unknown as AcceptedControlToolCommand,
        async () => {},
      );
      expect(filters).toContainEqual([
        "target_kind",
        "=",
        compute === null ? "development_environment" : "conversation",
      ]);
      expect(filters).toContainEqual([
        "target_id",
        "=",
        compute === null ? "parent-machine" : "child",
      ]);
    },
  );
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
        pi_session_id: sessionId,
        pi_conversation_id: "1",
        tenant_id: tenantId,
        project_id: projectId,
        workspace_id: workspaceId,
        desired_model_profile_id: profileId,
        state: "idle",
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
        tool_binding_id: "50000000-0000-4000-8000-000000000008",
        last_operation_id: "50000000-0000-4000-8000-000000000009",
        port: 3_000,
        protocol: "http",
        state: "active",
        ended_at: null,
      })
      .execute();

    const invoke = (args: Record<string, unknown>) =>
      executePreviewTool(
        database,
        {
          scope: { tenantId, sessionId },
          arguments: args,
        } as unknown as AcceptedControlToolCommand,
        async () => {},
      );
    await expect(invoke({ port: 3000, path: "/game" })).resolves.toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining(`/v1/conversations/${sessionId}/preview/3000/game`),
          },
        ],
        details: { port: 3000, previewPath: `/v1/conversations/${sessionId}/preview/3000/game` },
      },
    });
    await database
      .updateTable("sandbox_http_services")
      .set({ state: "ended", ended_at: new Date() })
      .where("tenant_id", "=", tenantId)
      .where("target_id", "=", sessionId)
      .execute();
    await expect(invoke({ port: 3000 })).resolves.toMatchObject({
      isError: true,
      result: {
        content: [{ type: "text", text: expect.stringContaining("preview_service_not_found") }],
      },
    });
  }, 20_000);
});
