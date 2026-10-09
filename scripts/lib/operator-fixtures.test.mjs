import { afterAll, beforeAll, expect, it } from "vitest";
import { testPostgres } from "./test-postgres.mjs";
import { createDatabase, runMigrations } from "../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../packages/control-plane/src/tenant-administration.ts";
import { PlatformRuntimeSettingsService } from "../../packages/control-plane/src/platform-runtime-settings.ts";
import { withCubeProxyFixture, restoreCubeProxyFixture } from "./cube-proxy-fixture.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./owned-acceptance-cleanup.mjs";
import { ControlPlaneStore } from "../../packages/control-plane/src/control-plane-store.ts";
import { randomUUID } from "node:crypto";

let pg, database, api, settings, actor;
it("refreshes siblings withdrawn by Stop and uses the queue revision for still-queued cleanup", async () => {
  const runs = new Map([
    ["active", { state: "running" }],
    ["withdrawn", { state: "queued" }],
    ["queued", { state: "queued" }],
  ]);
  const calls = [];
  await settleOwnedAcceptanceRuns(
    {
      async getRun(id) {
        return runs.get(id);
      },
      async cancelTurn(session, turn) {
        calls.push(["stop", session, turn]);
        runs.set("active", { state: "cancelled" });
        runs.set("withdrawn", { state: "cancelled" });
      },
      async getInputQueue() {
        return { revision: 7 };
      },
      async mutateQueuedInput(session, turn, action) {
        calls.push(["queue", session, turn, action]);
        runs.set("queued", { state: "cancelled" });
      },
    },
    "fixture",
    [...runs.keys()].map((id) => ({ id, turn_id: id, state: runs.get(id).state })),
    async () => {},
  );
  expect(calls).toEqual([
    ["stop", "fixture", "active"],
    ["queue", "fixture", "queued", { action: "cancel", revision: 7 }],
  ]);
});

it("accepts a lost cancellation reply after the Run has actually settled", async () => {
  let state = "running",
    calls = 0;
  await settleOwnedAcceptanceRuns(
    {
      async getRun() {
        return { state };
      },
      async cancelTurn() {
        calls++;
        state = "cancelled";
        throw new Error("reply lost");
      },
    },
    "fixture",
    [{ id: "run", turn_id: "turn" }],
    async () => {},
  );
  expect(calls).toBe(1);
});
beforeAll(async () => {
  pg = await testPostgres({});
  database = createDatabase({ connectionString: pg.url, maxConnections: 3 });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "operator-fixture",
    ownerDisplayName: "Operator",
  });
  actor = { ...tenant, userId: tenant.ownerUserId, role: "owner", platformAdministrator: true };
  settings = new PlatformRuntimeSettingsService({
    database,
    platformOperatorTenantId: tenant.tenantId,
  });
  api = { getIdentity: async () => actor, getCubeProxyConfiguration: () => settings.get(actor) };
}, 90_000);
afterAll(async () => {
  await database?.destroy();
  await pg?.close();
}, 30_000);

it("restores an originally unconfigured nullable proxy after fixture failure and permits an idempotent retry", async () => {
  const original = await settings.get(actor);
  expect(original.configured).toBe(false);
  let receipt;
  await expect(
    withCubeProxyFixture(
      {
        api,
        database,
        fallbackProxyUrl: "http://127.0.0.1:18081",
        saveReceipt: async (value) => {
          receipt = value;
        },
      },
      async () => {
        expect(await settings.get(actor)).toMatchObject({ enabled: true, configured: true });
        throw new Error("fixture failed");
      },
    ),
  ).rejects.toThrow("fixture failed");
  expect(await settings.get(actor)).toMatchObject({ enabled: false, configured: false });
  await restoreCubeProxyFixture(database, receipt);
  const audit = await database
    .selectFrom("platform_runtime_setting_changes")
    .selectAll()
    .orderBy("revision")
    .execute();
  expect(audit).toHaveLength(2);
  expect(audit[1].cube_proxy_url_sha256).toBeNull();
});

it("does not mutate settings if saving the private recovery receipt fails", async () => {
  const original = await settings.get(actor);
  await expect(
    withCubeProxyFixture(
      {
        api,
        database,
        fallbackProxyUrl: "http://127.0.0.1:18081",
        saveReceipt: async () => {
          throw new Error("disk full");
        },
      },
      async () => {
        throw new Error("must not run");
      },
    ),
  ).rejects.toThrow("disk full");
  expect(await settings.get(actor)).toEqual(original);
});

it("preserves a concurrent administrator change during teardown", async () => {
  await expect(
    withCubeProxyFixture(
      { api, database, fallbackProxyUrl: "http://127.0.0.1:18081", saveReceipt: async () => {} },
      async () => {
        await settings.replace(actor, { enabled: false, proxyUrl: "http://127.0.0.1:19091" });
      },
    ),
  ).rejects.toThrow("could not restore configuration");
  expect(await settings.get(actor)).toMatchObject({
    enabled: false,
    proxyUrl: "http://127.0.0.1:19091",
  });
});

it("refuses installation when an administrator edited settings after the snapshot", async () => {
  await expect(
    withCubeProxyFixture(
      {
        api,
        database,
        fallbackProxyUrl: "http://127.0.0.1:18081",
        saveReceipt: async () => {
          await settings.replace(actor, { enabled: false, proxyUrl: "http://127.0.0.1:20091" });
        },
      },
      async () => {
        throw new Error("must not run");
      },
    ),
  ).rejects.toThrow();
  expect(await settings.get(actor)).toMatchObject({
    enabled: false,
    proxyUrl: "http://127.0.0.1:20091",
  });
});

it.each(["release-acceptance-", "native-input-", "cube-check-"])(
  "only purges the owned %s fixture after physical Workspace cleanup and preserves the operator",
  async (prefix) => {
    const tenant = await createPrivateTenant(database, {
      slug: `${prefix}${randomUUID()}`,
      ownerDisplayName: "Owned fixture",
    });
    const store = new ControlPlaneStore({ database, ...tenant });
    const project = await store.createProject({ name: "Owned fixture", source: { kind: "empty" } });
    const blobs = {
      async delete() {
        throw new Error("Fixture has no image objects");
      },
    };
    await expect(purgeOwnedAcceptanceTenant(database, tenant, blobs)).rejects.toThrow(
      "settled/purged",
    );
    await database
      .updateTable("workspaces")
      .set({ deleted_at: new Date(), storage_purged_at: new Date() })
      .where("id", "=", project.workspaceId)
      .execute();
    expect(await purgeOwnedAcceptanceTenant(database, tenant, blobs)).toMatchObject({
      tenantRemoved: true,
    });
    expect(
      await database.selectFrom("tenants").select("id").where("id", "=", tenant.tenantId).execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("tenants")
        .select("id")
        .where("id", "=", actor.tenantId)
        .executeTakeFirst(),
    ).toBeDefined();
  },
);
