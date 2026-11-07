import { SkillMarketService } from "../../packages/control-plane/src/skill-market-service.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testPostgres } from "./test-postgres.mjs";
import { createDatabase, runMigrations } from "../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../packages/control-plane/src/tenant-administration.ts";
import { PlatformRuntimeSettingsService } from "../../packages/control-plane/src/platform-runtime-settings.ts";
import { withCubeProxyFixture, restoreCubeProxyFixture } from "./cube-proxy-fixture.mjs";
import {
  purgeOwnedAcceptanceTenant as purgeDeployedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./owned-acceptance-cleanup.mjs";
import { ControlPlaneStore } from "../../packages/control-plane/src/control-plane-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { DurablePostgresProjection } from "../../packages/pi-session-postgres/src/durable/index.ts";
import { PostgresAttachmentStore } from "../../packages/session-attachments/src/store.ts";
import { ResourceMeteringService } from "../../packages/accounting/src/resource-metering-service.ts";

// These DB fixtures launch no provider/compute sources. They explicitly inject
// their delivery boundary; maintained operators use the real source reader.
const purgeOwnedAcceptanceTenant = (db, tenant, blobs, options = {}) =>
  purgeDeployedAcceptanceTenant(db, tenant, blobs, {
    awaitReceiptDelivery: async ({ tenantId }) => ({ verified: true, tenantId }),
    ...options,
  });

let pg, database, api, settings, actor;

it("retains financial rows until the injected source delivery boundary completes", async () => {
  const tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-receipts-${randomUUID()}`,
    ownerDisplayName: "Owned receipt fixture",
  });
  const eventId = randomUUID();
  await new ResourceMeteringService(database).ingest({
    events: [
      {
        version: 1,
        eventId,
        resource: {
          kind: "workspace",
          resourceId: `owned-${randomUUID()}`,
          tenantId: tenant.tenantId,
          workspaceId: randomUUID(),
        },
        sourceId: "owned-source",
        sourceBootId: randomUUID(),
        incarnation: randomUUID(),
        from: "2026-11-07T00:00:00.000Z",
        to: "2026-11-07T00:00:01.000Z",
        quality: "confirmed",
        state: "retained",
        quantity: { kind: "workspace", capacityBytes: 32 * 1024 ** 3 },
      },
    ],
  });
  const blobs = {
    async delete() {
      throw new Error("No blob exists in this fixture");
    },
  };
  await expect(
    purgeOwnedAcceptanceTenant(database, tenant, blobs, {
      awaitReceiptDelivery: async () => {
        throw new Error("source still has pending receipts");
      },
    }),
  ).rejects.toThrow("pending receipts");
  expect(
    await database
      .selectFrom("resource_metering_events")
      .select("id")
      .where("id", "=", eventId)
      .execute(),
  ).toHaveLength(1);
  const entered = Promise.withResolvers(),
    delivered = Promise.withResolvers();
  const purging = purgeOwnedAcceptanceTenant(database, tenant, blobs, {
    awaitReceiptDelivery: async ({ tenantId }) => {
      expect(tenantId).toBe(tenant.tenantId);
      entered.resolve();
      await delivered.promise;
      return { verified: true, tenantId };
    },
  });
  try {
    await entered.promise;
    expect(
      await database.selectFrom("tenants").select("id").where("id", "=", tenant.tenantId).execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom("resource_metering_events")
        .select("id")
        .where("id", "=", eventId)
        .execute(),
    ).toHaveLength(1);
  } finally {
    delivered.resolve();
  }
  expect(await purging).toMatchObject({ tenantRemoved: true });
  expect(
    await database
      .selectFrom("resource_metering_events")
      .select("id")
      .where("id", "=", eventId)
      .execute(),
  ).toEqual([]);
});
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

it("retains an owned tenant while its image writer has no completion proof", async () => {
  const tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-write-${randomUUID()}`,
    ownerDisplayName: "Owned writer",
  });
  const entered = Promise.withResolvers(),
    complete = Promise.withResolvers();
  let deleted = 0;
  const blobs = {
    async put() {
      entered.resolve();
      await complete.promise;
    },
    async *readStream() {
      throw new Error("Not a read fixture");
    },
    async delete() {
      deleted++;
    },
  };
  const store = new PostgresAttachmentStore(database, blobs);
  const writing = store.put({ tenantId: tenant.tenantId }, Buffer.from("owned"), "image/png");
  try {
    await entered.promise;
    await expect(purgeOwnedAcceptanceTenant(database, tenant, blobs)).rejects.toThrow(
      "settled/purged",
    );
    expect(deleted).toBe(0);
    complete.resolve();
    await writing;
    expect(await purgeOwnedAcceptanceTenant(database, tenant, blobs)).toMatchObject({
      tenantRemoved: true,
      imagesRemoved: 1,
    });
    expect(deleted).toBe(1);
  } finally {
    complete.resolve();
    await writing;
  }
});

it("requires released machine evidence and deletes its metadata before environment versions", async () => {
  const tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-machine-${randomUUID()}`,
    ownerDisplayName: "Machine cleanup",
  });
  const store = new ControlPlaneStore({ database, ...tenant });
  const project = await store.createProject({ name: "Owned machine", source: { kind: "empty" } });
  const workspace = await database
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", project.workspaceId)
    .executeTakeFirstOrThrow();
  const version = await database
    .selectFrom("environment_versions")
    .select("id")
    .where("project_id", "=", project.projectId)
    .executeTakeFirstOrThrow();
  const id = randomUUID();
  await database
    .insertInto("development_environments")
    .values({
      id,
      tenant_id: tenant.tenantId,
      owner_user_id: tenant.ownerUserId,
      project_id: project.projectId,
      workspace_id: project.workspaceId,
      sandbox_domain_id: workspace.sandbox_domain_id,
      environment_version_id: version.id,
      owner_instance_id: null,
      owner_base_url: null,
      runtime_id: null,
      runtime_name: null,
      profile_key: "starter",
      cpu_count: 1,
      memory_mib: 2048,
      system_disk_gib: 20,
      state: "requested",
      failure_code: null,
      idempotency_key: "owned-machine",
      request_sha256: "a".repeat(64),
      released_at: null,
    })
    .execute();
  // This is an isolated PG fixture; stand in for the product's physical cleanup
  // receipt without introducing any real VM or deleting a user's resource.
  await database
    .updateTable("workspaces")
    .set({ deleted_at: new Date(), storage_purged_at: new Date() })
    .where("id", "=", project.workspaceId)
    .execute();
  const blobs = { delete: async () => {} };
  await expect(purgeOwnedAcceptanceTenant(database, tenant, blobs)).rejects.toThrow(
    "settled/purged",
  );
  await database
    .updateTable("development_environments")
    .set({
      state: "released",
      desired_state: "released",
      intent_revision: sql`intent_revision + 1`,
      allocation_closed: true,
      allocation_absent: true,
      released_at: new Date(),
    })
    .where("id", "=", id)
    .execute();
  expect(await purgeOwnedAcceptanceTenant(database, tenant, blobs)).toMatchObject({
    tenantRemoved: true,
  });
  expect(
    await database
      .selectFrom("development_environments")
      .select("id")
      .where("id", "=", id)
      .execute(),
  ).toHaveLength(0);
});

it("removes only the settled fixture's retained image edges before its objects", async () => {
  const tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-history-${randomUUID()}`,
    ownerDisplayName: "Retained fixture",
  });
  const deleted = [],
    blobs = { put: async () => {}, delete: async (key) => deleted.push(key) },
    images = new PostgresAttachmentStore(database, blobs);
  const image = await images.put(
      { tenantId: tenant.tenantId },
      Buffer.from("fixture"),
      "image/png",
    ),
    operatorImage = await images.put(
      { tenantId: actor.tenantId },
      Buffer.from("operator"),
      "image/png",
    );
  const sessionId = randomUUID();
  await database
    .insertInto("pi_sessions")
    .values({ tenant_id: tenant.tenantId, id: sessionId })
    .execute();
  const projection = new DurablePostgresProjection(database, {
    tenantId: tenant.tenantId,
    sessionId,
  });
  await projection.apply({
    seq: 1,
    nextId: 3,
    writes: [
      { type: "conversation", value: { id: 1 } },
      {
        type: "entry",
        value: {
          id: 2,
          conversationId: 1,
          kind: "fixture",
          image: { type: "pi_cloud_image_v1", attachment: image },
        },
      },
    ],
  });
  const header = randomUUID(),
    text = JSON.stringify({ input_uploads: [{ image }] });
  await sql`insert into pi_history_bodies(tenant_id,id,body_kind,sha256,payload_text,payload_bytes)
    values(${tenant.tenantId}::uuid,${header}::uuid,'metadata',${createHash("sha256").update(text).digest("hex")},${text},${Buffer.byteLength(text)})`.execute(
    database,
  );
  await sql`insert into pi_history_header_attachments(tenant_id,body_id,attachment_id) values(${tenant.tenantId}::uuid,${header}::uuid,${image.id}::uuid)`.execute(
    database,
  );
  const block = randomUUID(),
    product = randomUUID(),
    turn = randomUUID();
  await sql`insert into pi_history_blocks(tenant_id,id,source_session_id,source_pi_session_id,owner_pi_session_id,turn_id,origin_session_id,position,header_body_id)
    values(${tenant.tenantId}::uuid,${block}::uuid,${product}::uuid,${sessionId},${sessionId},${turn}::uuid,${product}::uuid,1,${header}::uuid)`.execute(
    database,
  );
  await sql`insert into pi_history_frames(tenant_id,block_id,seq,ordinal,record_id,entry_id,entry_record_id,body_id,body_bytes)
    select tenant_id,${block}::uuid,seq,ordinal,record_id,record_id,id,${header}::uuid,${Buffer.byteLength(text)}
    from pi_history_records where tenant_id=${tenant.tenantId}::uuid and record_id=2`.execute(
    database,
  );
  expect(
    (
      await sql`select * from pi_history_record_attachments where tenant_id=${tenant.tenantId}::uuid`.execute(
        database,
      )
    ).rows,
  ).toHaveLength(1);
  await expect(purgeOwnedAcceptanceTenant(database, tenant, blobs)).rejects.toThrow(
    "settled/purged",
  );
  expect(deleted).toEqual([]);
  await database.deleteFrom("pi_sessions").where("tenant_id", "=", tenant.tenantId).execute();
  expect(await purgeOwnedAcceptanceTenant(database, tenant, blobs)).toEqual({
    tenantRemoved: true,
    imagesRemoved: 1,
    skillObjectsRemoved: 0,
  });
  expect(deleted).toEqual([`session-images/${tenant.tenantId}/${image.id}`]);
  expect(
    await database
      .selectFrom("session_attachment_objects")
      .select("id")
      .where("tenant_id", "=", actor.tenantId)
      .where("id", "=", operatorImage.id)
      .execute(),
  ).toHaveLength(1);
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

it("retains unfinished Skill imports and removes only the settled fixture's package objects", async () => {
  const tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-skills-${randomUUID()}`,
    ownerDisplayName: "Skill fixture",
  });
  const entered = Promise.withResolvers(),
    complete = Promise.withResolvers(),
    deleted = [];
  const blobs = {
    async put(key) {
      if (key.includes(tenant.tenantId)) {
        entered.resolve();
        await complete.promise;
      }
    },
    async *readStream() {
      throw Error("not a read fixture");
    },
    async delete(key) {
      deleted.push(key);
    },
  };
  const service = new SkillMarketService({ database, blobs });
  const input = {
    label: "1",
    requirements: { tools: [], software: [], runtime: "none" },
    source: {
      kind: "files",
      files: [
        {
          path: "SKILL.md",
          base64: Buffer.from(
            "---\nname: fixture-skill\ndescription: Fixture\n---\nOnly inspect.",
          ).toString("base64"),
        },
      ],
    },
  };
  const original = await service.publish(actor, input);
  const writing = service.publish(
    { tenantId: tenant.tenantId, userId: tenant.ownerUserId, role: "owner" },
    input,
  );
  try {
    await entered.promise;
    await expect(purgeOwnedAcceptanceTenant(database, tenant, blobs)).rejects.toThrow(
      "settled/purged",
    );
    expect(deleted).toEqual([]);
    complete.resolve();
    await writing;
    expect(await purgeOwnedAcceptanceTenant(database, tenant, blobs)).toEqual({
      tenantRemoved: true,
      imagesRemoved: 0,
      skillObjectsRemoved: 1,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain(`skills/${tenant.tenantId}/`);
    const rows =
      await sql`select id from skill_versions where tenant_id=${actor.tenantId}::uuid and id=${original.versionId}::uuid`.execute(
        database,
      );
    expect(rows.rows).toHaveLength(1);
  } finally {
    complete.resolve();
    await writing;
  }
});
