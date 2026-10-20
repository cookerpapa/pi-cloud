import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import { WorkspaceUploadService } from "../../../packages/control-plane/src/workspace-upload-service.ts";
import { QueuedInputService } from "../../../packages/control-plane/src/queued-input-service.ts";
import { PostgresImageAttachmentStore } from "../../../packages/session-attachments/src/store.ts";
import { uploadRelativePath } from "../../../packages/protocol/src/user-upload.ts";
import {
  createControlPlaneApplication,
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
} from "../../../packages/control-plane/src/index.ts";
import { emptyEventRuntime } from "../../../packages/control-plane/test/fixtures/event-runtime.ts";

let f: Awaited<ReturnType<typeof nativeSubagentFixture>>;
let uploads: WorkspaceUploadService, images: PostgresImageAttachmentStore;
let app: NestFastifyApplication;
const blobs = new Map<string, Buffer>();
let holdPut: (() => Promise<void>) | undefined;
let holdRead: ((signal: AbortSignal) => Promise<void>) | undefined;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII=",
  "base64",
);
function content(bytes: Buffer) {
  return {
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    chunks: (async function* () {
      yield bytes;
    })(),
  };
}
async function collect(chunks: AsyncIterable<Uint8Array>) {
  const result: Buffer[] = [];
  for await (const chunk of chunks) result.push(Buffer.from(chunk));
  return Buffer.concat(result);
}
beforeAll(async () => {
  if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
    throw new Error("Use the isolated PG wrapper");
  f = await nativeSubagentFixture();
  // The generic native-control fixture has no vision model configuration.
  // Select a maintained multimodal Run descriptor; no provider is contacted.
  await f.database
    .updateTable("runs")
    .set({ provider: "openai-codex", model_id: "gpt-6-luna" })
    .where("id", "=", f.scope.runId)
    .execute();
  await f.database
    .updateTable("sessions")
    .set({ state: "running" })
    .where("id", "=", f.scope.sessionId)
    .execute();
  const uploader = {
    async uploadWorkspaceFile(
      request: { uploadId: string; name: string; sha256: string },
      chunks: AsyncIterable<Uint8Array>,
      signal?: AbortSignal,
    ) {
      const bytes = await collect(chunks);
      signal?.throwIfAborted();
      return {
        relativePath: uploadRelativePath(request.uploadId, request.name),
        byteLength: bytes.length,
        sha256: request.sha256,
      };
    },
  };
  images = new PostgresImageAttachmentStore(f.database, {
    async put(key, bytes) {
      blobs.set(key, Buffer.from(bytes));
    },
    async putStream(key, chunks, _length, _mime, signal) {
      const bytes = await collect(chunks);
      await holdPut?.();
      signal.throwIfAborted();
      blobs.set(key, bytes);
    },
    async *readStream(key, _maximum, signal) {
      await holdRead?.(signal);
      signal.throwIfAborted();
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("Missing owned object");
      yield bytes;
    },
    async delete(key) {
      blobs.delete(key);
    },
  });
  uploads = new WorkspaceUploadService({ database: f.database, uploader, images });
  app = await createControlPlaneApplication({
    database: f.database,
    eventRuntime: emptyEventRuntime(),
    workspaceUploader: uploader,
    imageAttachmentStore: images,
    productionHttpGateway: new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database: f.database }),
      readiness: () => true,
    }),
  });
  await app.listen(0, "127.0.0.1");
}, 60_000);
afterAll(async () => {
  await app?.close();
  await f?.close();
});
const upload = () =>
  uploads.upload(
    f.tenant.tenantId,
    f.tenant.ownerUserId,
    f.scope.sessionId,
    randomUUID(),
    "owned.png",
    content(png),
  );

it("characterizes a definitely unsent native input permanently pinning its image upload", async () => {
  const image = await upload();
  let backendLookups = 0,
    nativeCalls = 0;
  const queue = new QueuedInputService({
    database: f.database,
    backendFactory: async () => {
      backendLookups++;
      throw new Error("Worker route unavailable before sending any command");
      // No backend exists and no native input can have committed in this fixture.
    },
  });
  await expect(
    queue.accept(f.store, f.tenant.tenantId, f.scope.sessionId, "unroutable-upload-input", {
      prompt: "Owned unsent draft",
      uploadIds: [image.id],
    }),
  ).rejects.toMatchObject({ code: "input_delivery_unavailable" });
  expect(backendLookups).toBe(1);
  expect(nativeCalls).toBe(0);
  const row = await f.database
    .selectFrom("session_uploads")
    .select("accepted_at")
    .where("id", "=", image.id)
    .executeTakeFirstOrThrow();
  expect(row.accepted_at).not.toBeNull();
  await uploads.remove(f.tenant.tenantId, f.scope.sessionId, image.id);
  await f.database
    .updateTable("session_uploads")
    .set({ expires_at: new Date(0) })
    .where("id", "=", image.id)
    .execute();
  await sql`update session_image_objects set created_at=to_timestamp(0) where id=${image.image!.id}::uuid`.execute(
    f.database,
  );
  await images.reap();
  expect(
    await f.database
      .selectFrom("session_uploads")
      .select("id")
      .where("id", "=", image.id)
      .execute(),
  ).toHaveLength(1);
  expect(blobs.has(`session-images/${f.tenant.tenantId}/${image.image!.id}`)).toBe(true);
  process.stdout.write(
    JSON.stringify({
      case: "unsent_input_upload_pin",
      backendLookups,
      nativeCalls,
      acceptedMarkerSet: true,
      explicitRemoveRetainedRow: true,
      expiredDraftStillPinned: true,
      realPostgres: true,
    }) + "\n",
  );
});

it("characterizes deletion of an old in-flight upload inventory before its PUT finishes", async () => {
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const id = randomUUID();
  let objectId: string | undefined;
  holdPut = async () => {
    entered.resolve();
    await finish.promise;
  };
  const pending = uploads.upload(
    f.tenant.tenantId,
    f.tenant.ownerUserId,
    f.scope.sessionId,
    id,
    "late.png",
    content(png),
  );
  void pending.catch(() => {});
  try {
    await entered.promise;
    const pin = await f.database
      .selectFrom("session_uploads")
      .select("image_id")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    objectId = pin.image_id!;
    // A progressing upload may outlive the GC grace. Its claim is still current;
    // age only the object to reach that legitimate deletion candidate boundary.
    await sql`update session_image_objects set created_at=clock_timestamp()-interval '2 days'
      where id=${objectId}::uuid`.execute(f.database);
    await uploads.remove(f.tenant.tenantId, f.scope.sessionId, id);
    expect(await images.reap()).toBe(1);
    finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(blobs.has(`session-images/${f.tenant.tenantId}/${objectId}`)).toBe(true);
    expect(
      (
        await sql`select id from session_image_objects where id=${objectId}::uuid`.execute(
          f.database,
        )
      ).rows,
    ).toHaveLength(0);
    expect(await images.reap()).toBe(0);
    process.stdout.write(
      JSON.stringify({
        case: "late_upload_put_after_gc",
        objectAgeDays: 2,
        claimInitiallyCurrent: true,
        inventoryDeletedBeforePut: true,
        blobExistsAfterFailure: true,
        secondReapDeleted: 0,
        realPostgres: true,
        blobStore: "controlled",
      }) + "\n",
    );
  } finally {
    finish.resolve();
    await pending.catch(() => {});
    holdPut = undefined;
    if (objectId) blobs.delete(`session-images/${f.tenant.tenantId}/${objectId}`);
  }
});

it("characterizes browser image cancellation not reaching its source read", async () => {
  const image = await upload(),
    entered = Promise.withResolvers<AbortSignal>(),
    finish = Promise.withResolvers<void>();
  let readFinished = false;
  holdRead = async (signal) => {
    entered.resolve(signal);
    try {
      await Promise.race([
        finish.promise,
        new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    } finally {
      readFinished = true;
    }
  };
  const url = new URL(
    `/v1/sessions/${f.scope.sessionId}/uploads/${image.id}/image`,
    await app.getUrl(),
  );
  const request = httpRequest(url, {
    headers: { authorization: `Bearer ${f.tenant.credential.token}` },
  });
  request.on("error", () => {});
  request.on("response", (res) => res.resume());
  request.end();
  try {
    const sourceSignal = await entered.promise;
    request.destroy(new Error("Owned browser request cancelled"));
    await delay(40);
    expect(sourceSignal.aborted).toBe(false);
    expect(readFinished).toBe(false);
    process.stdout.write(
      JSON.stringify({
        case: "cancelled_preview_source_read",
        clientDisconnected: true,
        sourceAborted: false,
        sourceStillPending: true,
        realHttp: true,
        realPostgres: true,
        blobStore: "controlled",
      }) + "\n",
    );
  } finally {
    request.destroy();
    finish.resolve();
    await vi.waitFor(() => expect(readFinished).toBe(true));
    holdRead = undefined;
  }
});

it("characterizes an early unsupported-image rejection leaving its started iterator open", async () => {
  let closed = false;
  const bytes = Buffer.from("GIF89a owned fixture bytes");
  const chunks = (async function* () {
    try {
      yield bytes;
    } finally {
      closed = true;
    }
  })();
  try {
    await expect(
      uploads.upload(
        f.tenant.tenantId,
        f.tenant.ownerUserId,
        f.scope.sessionId,
        randomUUID(),
        "unsupported.gif",
        { ...content(bytes), chunks },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(closed).toBe(false);
    process.stdout.write(
      JSON.stringify({
        case: "early_upload_iterator_cleanup",
        rejected: true,
        sourceIteratorClosed: false,
        vmEffects: 0,
      }) + "\n",
    );
  } finally {
    await chunks.return();
    expect(closed).toBe(true);
  }
});
