import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { sql } from "kysely";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { WorkspaceUploadService, bindInputUploads } from "../src/workspace-upload-service.ts";
import { settleUploadPins } from "../src/upload-input-pins.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { PostgresImageAttachmentStore } from "../../session-attachments/src/store.ts";
import { uploadRelativePath } from "../../protocol/src/user-upload.ts";
import {
  createControlPlaneApplication,
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
} from "../src/index.ts";
import { emptyEventRuntime } from "./fixtures/event-runtime.ts";
import { fixtureModelRuntime } from "../../../scripts/lib/test-model-catalog.mjs";

let f: Awaited<ReturnType<typeof nativeSubagentFixture>>;
let uploads: WorkspaceUploadService, images: PostgresImageAttachmentStore;
let app: NestFastifyApplication;
const blobs = new Map<string, Buffer>();
let holdPut: (() => Promise<void>) | undefined;
let holdDelete: (() => Promise<void>) | undefined;
let rejectPartialPut = false;
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
    .set({
      provider: "openai-codex",
      model_id: "gpt-6-luna",
      thinking_level: "low",
      model_runtime_snapshot: sql`${JSON.stringify(fixtureModelRuntime("openai-codex", "gpt-6-luna"))}::jsonb`,
    })
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
      if (rejectPartialPut) {
        rejectPartialPut = false;
        const iterator = chunks[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.return?.();
        throw new Error("Incomplete single-attempt request body");
      }
      const bytes = await collect(chunks);
      const delayed = holdPut;
      await delayed?.();
      if (!delayed) signal.throwIfAborted();
      blobs.set(key, bytes);
    },
    async *readStream(key, _maximum, signal) {
      await holdRead?.(signal);
      signal.throwIfAborted();
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("Missing owned object");
      const half = Math.max(1, Math.floor(bytes.length / 2));
      yield bytes.subarray(0, half);
      yield bytes.subarray(half);
    },
    async delete(key) {
      blobs.delete(key);
      await holdDelete?.();
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

it("releases only the provisional upload pin when native delivery was definitely not sent", async () => {
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
  expect(row.accepted_at).toBeNull();
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
  ).toHaveLength(0);
  expect(blobs.has(`session-images/${f.tenant.tenantId}/${image.image!.id}`)).toBe(false);
});

it.each(["after_reap", "during_delete"])(
  "retains late PUT cleanup identity (%s)",
  async (timing) => {
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
      const removal = uploads.remove(f.tenant.tenantId, f.scope.sessionId, id);
      await vi.waitFor(async () =>
        expect(
          await f.database
            .selectFrom("session_uploads")
            .select("id")
            .where("id", "=", id)
            .execute(),
        ).toHaveLength(0),
      );
      if (timing === "during_delete")
        holdDelete = async () => {
          holdDelete = undefined;
          finish.resolve();
          await pending.catch(() => {});
        };
      expect(await images.reap()).toBe(0);
      expect(
        (
          await sql`select id from session_image_objects where id=${objectId}::uuid`.execute(
            f.database,
          )
        ).rows,
      ).toHaveLength(1);
      finish.resolve();
      await expect(pending).rejects.toMatchObject({ code: "conflict" });
      await removal;
      expect(blobs.has(`session-images/${f.tenant.tenantId}/${objectId}`)).toBe(true);
      await sql`update session_image_objects set cleanup_available_at=to_timestamp(0) where id=${objectId}::uuid`.execute(
        f.database,
      );
      expect(await images.reap()).toBe(1);
      expect(blobs.has(`session-images/${f.tenant.tenantId}/${objectId}`)).toBe(false);
    } finally {
      finish.resolve();
      await pending.catch(() => {});
      holdPut = undefined;
      holdDelete = undefined;
      if (objectId) blobs.delete(`session-images/${f.tenant.tenantId}/${objectId}`);
    }
  },
);

it("cancels the image source when the browser disconnects", async () => {
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
    await vi.waitFor(() => expect(sourceSignal.aborted).toBe(true));
    expect(readFinished).toBe(true);
  } finally {
    request.destroy();
    finish.resolve();
    await vi.waitFor(() => expect(readFinished).toBe(true));
    holdRead = undefined;
  }
});

it("closes the started upload iterator on early image refusal", async () => {
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
    expect(closed).toBe(true);
  } finally {
    await chunks.return();
    expect(closed).toBe(true);
  }
});

it("closes the sniffed source when PG rejects its upload claim", async () => {
  let closed = false;
  const chunks = (async function* () {
    try {
      yield png;
    } finally {
      closed = true;
    }
  })();
  await expect(
    uploads.upload(
      f.tenant.tenantId,
      f.tenant.ownerUserId,
      randomUUID(),
      randomUUID(),
      "image.png",
      { ...content(png), chunks },
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(closed).toBe(true);
});

it("can retire an image write that stopped before transmitting its complete body", async () => {
  const id = randomUUID();
  const bytes = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
  rejectPartialPut = true;
  const chunks = (async function* () {
    for (let at = 0; at < bytes.length; at += 65536) yield bytes.subarray(at, at + 65536);
  })();
  await expect(
    uploads.upload(
      f.tenant.tenantId,
      f.tenant.ownerUserId,
      f.scope.sessionId,
      id,
      "incomplete.png",
      { ...content(bytes), chunks },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  const row = await f.database
    .selectFrom("session_uploads")
    .select(["state", "image_id"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  expect(row.state).toBe("failed");
  const ended = await sql`select id from session_image_objects where id=${row.image_id}::uuid
    and state='uploading' and write_completed_at is not null`.execute(f.database);
  expect(ended.rows).toHaveLength(1);
  await uploads.remove(f.tenant.tenantId, f.scope.sessionId, id);
  await sql`update session_image_objects set created_at=to_timestamp(0) where id=${row.image_id}::uuid`.execute(
    f.database,
  );
  expect(await images.reap()).toBe(1);
});

it("rechecks provisional pins after waiting for concurrent upload admission", async () => {
  const image = await upload(),
    id = randomUUID();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const admission = f.database.transaction().execute(async (tx) => {
    await bindInputUploads(tx, {
      tenantId: f.tenant.tenantId,
      sessionId: f.scope.sessionId,
      workspaceId: image.workspaceId,
      workingDirectory: "/workspace",
      ids: [image.id],
      pin: {
        id,
        piSessionId: f.scope.piSessionId,
        conversationId: 1,
        runId: f.scope.runId,
        writerId: f.scope.writerId,
        kind: "submit",
        operationId: "owned-race",
        fingerprint: "a".repeat(64),
      },
    });
    entered.resolve();
    await release.promise;
  });
  void admission.catch(entered.reject);
  await entered.promise;
  const removal = uploads.remove(f.tenant.tenantId, f.scope.sessionId, image.id);
  try {
    await vi.waitFor(async () => {
      const result = await sql`select 1 from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like 'select "id" from "session_uploads"%'`.execute(
        f.database,
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });
    release.resolve();
    await admission;
    await removal;
    expect(
      await f.database
        .selectFrom("session_uploads")
        .select("id")
        .where("id", "=", image.id)
        .execute(),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await admission;
    await removal;
    await settleUploadPins(f.database, id, false);
    await uploads.remove(f.tenant.tenantId, f.scope.sessionId, image.id);
  }
});

it("cannot complete a successful full HTTP image response after a hash failure", async () => {
  const image = await upload();
  const key = `session-images/${f.tenant.tenantId}/${image.image!.id}`;
  const original = blobs.get(key)!;
  blobs.set(key, Buffer.alloc(original.length, 1));
  try {
    const baseUrl = await app.getUrl();
    const result = await new Promise<{ completed: boolean; bytes: number }>((resolve) => {
      let bytes = 0;
      const request = httpRequest(
        new URL(`/v1/sessions/${f.scope.sessionId}/uploads/${image.id}/image`, baseUrl),
        { headers: { authorization: `Bearer ${f.tenant.credential.token}` } },
      );
      request.on("error", () => resolve({ completed: false, bytes }));
      request.on("response", (response) => {
        response.on("data", (chunk) => {
          bytes += chunk.length;
        });
        response.on("end", () => resolve({ completed: response.complete, bytes }));
        response.on("error", () => resolve({ completed: false, bytes }));
        response.on("aborted", () => resolve({ completed: false, bytes }));
      });
      request.setTimeout(3000, () => request.destroy(new Error("Fixture response timed out")));
      request.end();
    });
    expect(result.completed).toBe(false);
    expect(result.bytes).toBeLessThan(original.length);
  } finally {
    blobs.set(key, original);
  }
});
