import { createDatabase, runMigrations } from "@pi-cloud/database";
import { sql } from "kysely";
import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresPiSessionStorage,
  PostgresPiSessionRepository,
  rebuildPostgresPiSessionProjections,
} from "../../pi-session-postgres/src/index.ts";
import { ImageAttachmentCodec } from "../src/codec.ts";
import { PostgresImageAttachmentStore, type ImageBlobStore } from "../src/store.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";

const integrationUrl = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!integrationUrl)("Session image storage on PostgreSQL", () => {
  let admin: ReturnType<typeof createDatabase>, db: ReturnType<typeof createDatabase>;
  const databaseName = `pi_image_test_${randomUUID().replaceAll("-", "")}`;
  const tenantId = randomUUID(),
    otherTenant = randomUUID();
  const bytes = new Map<string, Buffer>();
  let failPut = false,
    failDelete = false;
  const blobs: ImageBlobStore = {
    async put(key, value, _mime, signal) {
      signal.throwIfAborted();
      if (failPut) throw new Error("upload failed");
      bytes.set(key, Buffer.from(value));
    },
    async get(key) {
      const value = bytes.get(key);
      if (!value) throw new Error("missing image");
      return value;
    },
    async delete(key) {
      if (failDelete) throw new Error("delete interrupted");
      bytes.delete(key);
    },
  };
  let store: PostgresImageAttachmentStore, codec: ImageAttachmentCodec;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: integrationUrl!, maxConnections: 1 });
    await sql`create database ${sql.id(databaseName)}`.execute(admin);
    const url = new URL(integrationUrl!);
    url.pathname = `/${databaseName}`;
    url.searchParams.set(
      "options",
      "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    await runMigrations(db, "up");
    await db
      .insertInto("tenants")
      .values([
        { id: tenantId, slug: tenantId },
        { id: otherTenant, slug: otherTenant },
      ])
      .execute();
    store = new PostgresImageAttachmentStore(db, blobs);
    codec = new ImageAttachmentCodec(store);
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      try {
        await sql`drop database if exists ${sql.id(databaseName)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  });

  it.each(["toolResult", "user"] as const)(
    "cold public SessionStorage reads reconstruct exact images while PG stores only references (%s)",
    async (role) => {
      const id = randomUUID(),
        native = await PostgresPiSessionStorage.create({
          database: db,
          tenantId,
          sessionId: id,
          images: codec,
        });
      const image = {
        type: "image" as const,
        data: randomBytes(2 * 1024 * 1024).toString("base64"),
        mimeType: "image/png",
      };
      const entry = await native.appendEntry(
        {
          id: "image",
          type: "message",
          message:
            role === "user"
              ? { role: "user", content: [image], timestamp: 1 }
              : {
                  role: "toolResult",
                  toolCallId: "call",
                  toolName: "read",
                  isError: false,
                  content: [image],
                  timestamp: 1,
                },
        },
        "main",
      );
      const { rows } = await sql<{
        payload: unknown;
      }>`select payload from pi_session_log where tenant_id=${tenantId}::uuid and session_id=${id}`.execute(
        db,
      );
      expect(JSON.stringify(rows).length).toBeLessThan(2048);
      expect(JSON.stringify(rows)).toContain("pi_cloud_image_v1");
      const cold = new PostgresPiSessionStorage({
        database: db,
        tenantId,
        sessionId: id,
        images: new ImageAttachmentCodec(new PostgresImageAttachmentStore(db, blobs)),
      });
      expect(await cold.getEntry("image")).toEqual(entry);
      expect(await cold.findEntriesOnBranch({ start: "image" })).toEqual([entry]);
      expect((await cold.getLog())[0]).toMatchObject({ entry });
      expect(await store.reap(0)).toBe(0);
      const repo = new PostgresPiSessionRepository({ database: db, tenantId, images: codec });
      const fork = await repo.fork(await native.getMetadata(), { id: randomUUID() });
      const nested = await repo.fork(await fork.getMetadata(), { id: randomUUID() });
      // Direct source deletion requires no rebuild or materialization of a COW view.
      await repo.delete(await native.getMetadata());
      expect(await store.reap(0)).toBe(0);
      expect(await fork.getEntry("image")).toEqual(entry);
      await repo.delete(await fork.getMetadata());
      expect(await store.reap(0)).toBe(0);
      expect(await nested.getEntry("image")).toEqual(entry);
      await rebuildPostgresPiSessionProjections(db, {
        tenantId,
        sessionId: (await nested.getMetadata()).id,
      });
      expect(await nested.getEntry("image")).toEqual(entry);
      await repo.delete(await nested.getMetadata());
      expect(await store.reap(0)).toBe(1);
    },
  );

  it("missing and cross-tenant images fail explicitly without substituting a mutable file", async () => {
    const ref = await store.put({ tenantId }, Buffer.from("test bytes"), "image/png");
    await expect(store.get(otherTenant, ref)).rejects.toThrow("tenant");
    bytes.set(`session-images/${tenantId}/${ref.id}`, Buffer.from("corrupt"));
    await expect(store.get(tenantId, ref)).rejects.toThrow("integrity");
  });

  it("reaps only claimed tenant/object pairs when tenants share an object ID", async () => {
    const data = Buffer.from("same immutable bytes");
    const ref = await store.put({ tenantId }, data, "image/png");
    await sql`update session_image_objects set created_at=clock_timestamp()-interval '2 days'
      where tenant_id=${tenantId}::uuid and id=${ref.id}::uuid`.execute(db);
    await sql`insert into session_image_objects(tenant_id,id,state,sha256,byte_length,mime_type)
      values(${otherTenant}::uuid,${ref.id}::uuid,'ready',${ref.sha256},${ref.byteLength},${ref.mimeType})`.execute(
      db,
    );
    bytes.set(`session-images/${otherTenant}/${ref.id}`, data);
    expect(await store.reap()).toBe(1);
    await expect(store.get(otherTenant, ref)).resolves.toEqual(data);
    expect(bytes.has(`session-images/${tenantId}/${ref.id}`)).toBe(false);
  });

  it("keeps opaque custom JSON outside attachment reachability", async () => {
    const sessionId = randomUUID();
    const native = await PostgresPiSessionStorage.create({
      database: db,
      tenantId,
      sessionId,
      images: codec,
    });
    const data = {
      type: "pi_cloud_image_v1",
      attachment: { id: randomUUID(), example: "user data" },
    };
    await native.appendEntry({ id: "opaque", type: "custom", customType: "example", data }, "main");
    expect(await native.getEntry("opaque")).toMatchObject({ data });
    const { rows } =
      await sql`select * from session_image_references where session_id=${sessionId}`.execute(db);
    expect(rows).toHaveLength(0);
  });

  it("failed uploads stay unpublishable and interrupted cleanup is repeatable", async () => {
    failPut = true;
    await expect(store.put({ tenantId }, Buffer.from("failed"), "image/png")).rejects.toThrow(
      "upload failed",
    );
    failPut = false;
    const {
      rows: [upload],
    } = await sql<{
      id: string;
      sha256: string;
      byte_length: string;
      mime_type: string;
    }>`select * from session_image_objects where state='uploading'`.execute(db);
    expect(upload).toBeDefined();
    const sessionId = randomUUID();
    await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
    const fake = {
      type: "pi_cloud_image_v1",
      attachment: {
        id: upload!.id,
        sha256: upload!.sha256,
        byteLength: Number(upload!.byte_length),
        mimeType: upload!.mime_type,
      },
    };
    await expect(
      sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload) values(${tenantId}::uuid,${sessionId},1,'entry',${JSON.stringify({ lane: "main", turnId: null, entry: { id: "image", type: "message", seq: 1, timestamp: 1, parentId: null, message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, timestamp: 1, content: [fake] } } })}::jsonb)`.execute(
        db,
      ),
    ).rejects.toThrow("unavailable");
    failDelete = true;
    await expect(store.reap(0)).rejects.toThrow("delete interrupted");
    failDelete = false;
    const retry = new PostgresImageAttachmentStore(db, blobs);
    expect(await retry.reap(0)).toBeGreaterThan(0);
    const remaining = await sql`select id from session_image_objects where state!='ready'`.execute(
      db,
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it("protects uploads until their Run is sealed, including the unprojected Kafka interval", async () => {
    const tenant = await createPrivateTenant(db, {
      slug: `image-${randomUUID()}`,
      ownerDisplayName: "image test",
    });
    const control = new ControlPlaneStore({ database: db, ...tenant });
    const project = await control.createProject({ name: "image", source: { kind: "empty" } });
    const session = await control.createSession(
      project.projectId,
      project.workspaceId,
      "image",
      "elastic",
    );
    const run = await control.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "image retention",
    });
    const ref = await store.put(
      { tenantId: tenant.tenantId, runId: run.runId },
      Buffer.from("unprojected"),
      "image/png",
    );
    expect(await store.reap(0)).toBe(0);
    expect((await store.get(tenant.tenantId, ref)).toString()).toBe("unprojected");
    // Model a terminal projection, not another execution attempt.
    await sql`update runs set output_sealed_at=clock_timestamp() where id=${run.runId}::uuid`.execute(
      db,
    );
    expect(await store.reap(0)).toBe(1);
    await expect(store.get(tenant.tenantId, ref)).rejects.toThrow("unavailable");
  });

  it("serializes cleanup claims with new native references", async () => {
    const ref = await store.put({ tenantId }, Buffer.from("claimed"), "image/png");
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const delayed = new PostgresImageAttachmentStore(db, {
      ...blobs,
      async delete(key, signal) {
        held.resolve();
        await release.promise;
        return blobs.delete(key, signal);
      },
    });
    const reaping = delayed.reap(0);
    await held.promise;
    try {
      const sessionId = randomUUID();
      await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
      const image = { type: "pi_cloud_image_v1", attachment: ref };
      await expect(
        sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload) values(${tenantId}::uuid,${sessionId},1,'entry',${JSON.stringify({ lane: "main", turnId: null, entry: { id: "image", type: "message", seq: 1, timestamp: 1, parentId: null, message: { role: "toolResult", toolCallId: "call", toolName: "read", isError: false, timestamp: 1, content: [image] } } })}::jsonb)`.execute(
          db,
        ),
      ).rejects.toThrow("unavailable");
    } finally {
      release.resolve();
      await reaping;
    }
  });
});
