import { createTestWorker } from "./admit-test-execution.ts";
import type { TurnSteerRequest } from "../src/turn-steer.ts";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { parseUserUpload, parseTurnSteerResource, uploadRelativePath } from "@pi-cloud/protocol";
import { PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";
import {
  createControlPlaneApplication,
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
  createPrivateTenant,
  issuePrivateTenantCredential,
} from "../src/index.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { WorkspaceUploadService, type WorkspaceUploader } from "../src/workspace-upload-service.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { TurnSteeringService } from "../src/turn-steering-service.ts";
import { emptyEventRuntime } from "./fixtures/event-runtime.ts";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!external).sequential("Workspace uploads and durable user attachments", () => {
  let admin: ReturnType<typeof createDatabase>, db: ReturnType<typeof createDatabase>;
  let app: NestFastifyApplication, http: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof createPrivateTenant>>, other: typeof tenant;
  let store: ControlPlaneStore,
    uploads: WorkspaceUploadService,
    images: PostgresImageAttachmentStore;
  const name = `input_uploads_${randomUUID().replaceAll("-", "")}`;
  const blobs = new Map<string, Buffer>();
  const placed = new Map<string, Buffer>();
  let hold: (() => Promise<void>) | undefined;
  const place = vi.fn<WorkspaceUploader["uploadWorkspaceFile"]>(async (request, bytes, signal) => {
    await hold?.();
    signal?.throwIfAborted();
    placed.set(request.uploadId, Buffer.from(bytes));
    return {
      relativePath: uploadRelativePath(request.uploadId, request.name),
      byteLength: bytes.length,
      sha256: request.sha256,
    };
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII=",
    "base64",
  );
  beforeAll(async () => {
    admin = createDatabase({ connectionString: external!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(external!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 6 });
    await runMigrations(db, "up");
    tenant = await createPrivateTenant(db, {
      slug: "uploads",
      ownerDisplayName: "Uploads",
      initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
    });
    other = await createPrivateTenant(db, { slug: "other", ownerDisplayName: "Other" });
    store = new ControlPlaneStore({ database: db, ...tenant });
    images = new PostgresImageAttachmentStore(db, {
      async put(key, bytes) {
        blobs.set(key, Buffer.from(bytes));
      },
      async get(key) {
        const value = blobs.get(key);
        if (!value) throw new Error("Missing blob");
        return value;
      },
      async delete(key) {
        blobs.delete(key);
      },
    });
    uploads = new WorkspaceUploadService({
      database: db,
      uploader: { uploadWorkspaceFile: place },
      images,
    });
    app = await createControlPlaneApplication({
      database: db,
      eventRuntime: emptyEventRuntime(),
      workspaceUploader: { uploadWorkspaceFile: place },
      imageAttachmentStore: images,
      productionHttpGateway: new ProductionHttpGateway({
        authenticator: new PostgresTenantApiAuthenticator({ database: db }),
        readiness: () => true,
      }),
    });
    await app.listen(0, "127.0.0.1");
    await app.get(QueuedInputService).onApplicationShutdown();
    http = app.getHttpAdapter().getInstance() as FastifyInstance;
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin) {
      await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  });
  async function session() {
    const p = await store.createProject({
      name: `uploads-${randomUUID()}`,
      source: { kind: "empty" },
    });
    return store.createSession(p.projectId, p.workspaceId, "Attachments", "elastic");
  }
  function headers(token = tenant.credential.token) {
    return { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" };
  }
  async function upload(sessionId: string, id = randomUUID(), bytes = png, name = "capture.png") {
    const response = await http.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/uploads/${id}?name=${encodeURIComponent(name)}`,
      headers: headers(),
      payload: bytes,
    });
    expect(response.statusCode, response.body).toBe(200);
    return parseUserUpload(response.json());
  }
  it("authenticates binary requests, accepts files above the default parser limit, and retries the same identity", async () => {
    const s = await session(),
      id = randomUUID(),
      bytes = Buffer.alloc(2 * 1024 * 1024, 65);
    const url = `/v1/sessions/${s.sessionId}/uploads/${id}?name=notes.txt`;
    const count = place.mock.calls.length;
    expect(
      (
        await http.inject({
          method: "PUT",
          url,
          headers: { "content-type": "application/octet-stream" },
          payload: bytes,
        })
      ).statusCode,
    ).toBe(401);
    const a = await upload(s.sessionId, id, bytes, "notes.txt");
    expect(a.path).toBe(`/workspace/uploads/${id}/notes.txt`);
    expect(a.image).toBeUndefined();
    expect(await upload(s.sessionId, id, bytes, "notes.txt")).toEqual(a);
    expect(place.mock.calls.length - count).toBe(1);
    expect(
      (
        await http.inject({
          method: "PUT",
          url,
          headers: headers(),
          payload: Buffer.from("changed"),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await http.inject({
          method: "PUT",
          url,
          headers: headers(other.credential.token),
          payload: bytes,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await http.inject({
          method: "PUT",
          url,
          headers: headers(),
          payload: Buffer.alloc(16 * 1024 * 1024 + 1),
        })
      ).statusCode,
    ).toBe(413);
  });
  it("pins image-only input through queue editing, cancellation, Workspace changes and image GC", async () => {
    const s = await session(),
      image = await upload(s.sessionId);
    const accepted = await store.acceptTurn(s.sessionId, "image-only", {
      prompt: "",
      uploadIds: [image.id],
    });
    const row = await db
      .selectFrom("turns")
      .select(["input_text", "input_uploads"])
      .where("id", "=", accepted.turnId)
      .executeTakeFirstOrThrow();
    expect(row.input_text).toBe("");
    expect(row.input_uploads).toEqual([image]);
    expect(JSON.stringify(row)).not.toContain(png.toString("base64"));
    const queue = new QueuedInputService({
      database: db,
      steering: new TurnSteeringService({
        database: db,
        backendFactory: async () => ({ steer: async () => {} }),
      }),
    });
    const before = await queue.list(tenant.tenantId, s.sessionId);
    expect(before.items[0]?.uploads).toEqual([image]);
    await queue.mutate(tenant.tenantId, s.sessionId, accepted.turnId, "edit", {
      action: "edit",
      revision: before.revision,
      text: "Explain this",
    });
    const edited = await queue.list(tenant.tenantId, s.sessionId);
    expect(edited.items[0]).toMatchObject({ text: "Explain this", uploads: [image] });
    await queue.mutate(tenant.tenantId, s.sessionId, accepted.turnId, "cancel", {
      action: "cancel",
      revision: edited.revision,
    });
    await uploads.remove(tenant.tenantId, s.sessionId, image.id);
    placed.delete(image.id);
    await db
      .updateTable("session_uploads")
      .set({ expires_at: new Date(0) })
      .where("id", "=", image.id)
      .execute();
    await images.reap(0);
    expect((await uploads.image(tenant.tenantId, s.sessionId, image.id)).bytes).toEqual(png);
    const otherSession = await session();
    await expect(
      store.acceptTurn(otherSession.sessionId, "wrong-scope", {
        prompt: "",
        uploadIds: [image.id],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const preview = await http.inject({
      method: "GET",
      url: `/v1/sessions/${s.sessionId}/uploads/${image.id}/image`,
      headers: headers(other.credential.token),
    });
    expect(preview.statusCode).toBe(404);
  });
  it("carries images through Worker admission, history, direct steer and queued promotion", async () => {
    const s = await session(),
      image = await upload(s.sessionId);
    const first = await store.acceptTurn(s.sessionId, "active-image", {
      prompt: "",
      uploadIds: [image.id],
    });
    const second = await store.acceptTurn(s.sessionId, "queued-image", {
      prompt: "",
      uploadIds: [image.id],
    });
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const worker = await createTestWorker(db);
    let captured: unknown;
    const execution = worker
      .executor({
        execute: async (request) => {
          captured = request.input;
          entered.resolve();
          await finish.promise;
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(first.runId);
    void execution.catch((error) => entered.reject(error));
    const delivered: TurnSteerRequest[] = [];
    const steering = new TurnSteeringService({
      database: db,
      backendFactory: async () => ({
        steer: async (request) => {
          delivered.push(request);
        },
      }),
    });
    const queue = new QueuedInputService({ database: db, steering });
    try {
      await entered.promise;
      expect(captured).toMatchObject({ prompt: "", uploads: [image] });
      const conversation = await http.inject({
        method: "GET",
        url: `/v1/conversations/${s.sessionId}`,
        headers: headers(),
      });
      expect(conversation.statusCode, conversation.body).toBe(200);
      expect(conversation.json().turns[0]).toMatchObject({ prompt: "", uploads: [image] });
      const q = await queue.list(tenant.tenantId, s.sessionId);
      await queue.mutate(tenant.tenantId, s.sessionId, second.turnId, "promote-image", {
        action: "steer",
        revision: q.revision,
        targetTurnId: first.turnId,
      });
      await queue.reconcileOnce();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ text: "", uploads: [image] });
      const viewer = await issuePrivateTenantCredential(db, {
        tenant: tenant.tenantId,
        userId: tenant.ownerUserId,
        label: "Steer viewer",
        role: "viewer",
      });
      const request = {
        method: "POST" as const,
        url: `/v1/sessions/${s.sessionId}/turns/${first.turnId}/steers`,
        payload: { text: "", uploadIds: [image.id] },
      };
      for (const [token, status] of [
        [other.credential.token, 404],
        [viewer.token, 403],
      ] as const) {
        const denied = await http.inject({
          ...request,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": "direct-image" },
        });
        expect(denied.statusCode, denied.body).toBe(status);
      }
      const accepted = await http.inject({
        ...request,
        headers: {
          authorization: `Bearer ${tenant.credential.token}`,
          "idempotency-key": "direct-image",
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const direct = parseTurnSteerResource(accepted.json());
      expect(direct).toMatchObject({ state: "accepted", targetTurnId: first.turnId });
      expect(delivered).toHaveLength(1);
      await queue.reconcileOnce();
      expect(delivered).toHaveLength(2);
      expect(delivered[1]).toMatchObject({ text: "", uploads: [image] });
      expect(
        await db
          .selectFrom("turns")
          .select("input_uploads")
          .where("id", "=", direct.sourceTurnId)
          .executeTakeFirst(),
      ).toMatchObject({ input_uploads: [image] });
    } finally {
      finish.resolve();
      await execution;
    }
  });

  it("expires unaccepted image drafts and rejects completion after a claim is removed", async () => {
    const s = await session(),
      draft = await upload(s.sessionId);
    await db
      .updateTable("session_uploads")
      .set({ expires_at: new Date(0) })
      .where("id", "=", draft.id)
      .execute();
    await images.reap(0);
    await expect(uploads.image(tenant.tenantId, s.sessionId, draft.id)).rejects.toMatchObject({
      code: "not_found",
    });
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>(),
      id = randomUUID();
    hold = async () => {
      entered.resolve();
      await finish.promise;
    };
    const result = uploads
      .upload(tenant.tenantId, tenant.ownerUserId, s.sessionId, id, "later.png", png)
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      await uploads.remove(tenant.tenantId, s.sessionId, id);
    } finally {
      hold = undefined;
      finish.resolve();
    }
    expect(await result).toMatchObject({ code: "conflict" });
    expect(
      await db.selectFrom("session_uploads").select("id").where("id", "=", id).executeTakeFirst(),
    ).toBeUndefined();
    await images.reap(0);
  });
  it("limits simultaneous HTTP bodies and fails closed if image cleanup wins publication", async () => {
    const s = await session(),
      entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let enteredCount = 0;
    hold = async () => {
      if (++enteredCount === 2) entered.resolve();
      await finish.promise;
    };
    const pending = [upload(s.sessionId), upload(s.sessionId)];
    try {
      await entered.promise;
      const rejected = await http.inject({
        method: "PUT",
        url: `/v1/sessions/${s.sessionId}/uploads/${randomUUID()}?name=third.txt`,
        headers: headers(),
        payload: Buffer.from("third"),
      });
      expect(rejected.statusCode).toBe(429);
    } finally {
      hold = undefined;
      finish.resolve();
      await Promise.all(pending);
    }
    const original = images.put.bind(images);
    const put = vi.spyOn(images, "put").mockImplementationOnce(async (...args) => {
      const ref = await original(...args);
      await images.reap(0);
      return ref;
    });
    try {
      await expect(
        uploads.upload(
          tenant.tenantId,
          tenant.ownerUserId,
          s.sessionId,
          randomUUID(),
          "raced.png",
          png,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      put.mockRestore();
    }
  });

  it("rejects unsafe names, unsupported images and aborted requests before placement", async () => {
    const s = await session();
    const count = place.mock.calls.length;
    await expect(
      uploads.upload(tenant.tenantId, tenant.ownerUserId, s.sessionId, randomUUID(), "../x", png),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      uploads.upload(
        tenant.tenantId,
        tenant.ownerUserId,
        s.sessionId,
        randomUUID(),
        "x.gif",
        Buffer.from("GIF89a"),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      uploads.upload(
        tenant.tenantId,
        tenant.ownerUserId,
        s.sessionId,
        randomUUID(),
        "x.png",
        png,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(place.mock.calls.length).toBe(count);
  });
});
