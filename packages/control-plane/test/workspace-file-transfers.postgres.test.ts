import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql, CompiledQuery } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { workspaceFileTransfer, UploadStagingArea } from "@pi-cloud/workspace-runtime";
import { Upload as TusUpload } from "tus-js-client";
import {
  createControlPlaneApplication,
  createPrivateTenant,
  PostgresTenantApiAuthenticator,
  ProductionHttpGateway,
} from "../src/index.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { WorkspaceFileTransferService } from "../src/workspace-file-transfer-service.ts";
import { workspaceFileTransferGrantQuery } from "../../sandbox-control/src/workspace-file-transfer-grant.ts";
import { emptyEventRuntime } from "./fixtures/event-runtime.ts";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!external).sequential("Workspace-only tus admission and receiver recovery", () => {
  let admin: ReturnType<typeof createDatabase>, db: ReturnType<typeof createDatabase>;
  let app: NestFastifyApplication,
    tenant: Awaited<ReturnType<typeof createPrivateTenant>>,
    store: ControlPlaneStore;
  let root: string, base: string, sessionId: string, workspaceId: string;
  let loseCompletion = false;
  const databaseName = `workspace_transfer_${randomUUID().replaceAll("-", "")}`;
  const bytes = Buffer.from("source-file-data-for-recovery");
  const headers = () => ({ authorization: `Bearer ${tenant.credential.token}` });
  const start = async () => {
    app = await createControlPlaneApplication({
      database: db,
      eventRuntime: emptyEventRuntime(),
      workspaceFileTransfers: {
        workspaceFileTransfer: async (request, chunks, signal) => {
          const query = workspaceFileTransferGrantQuery(request);
          expect(
            (await db.executeQuery(CompiledQuery.raw(query.text, query.values))).rows,
          ).toHaveLength(1);
          const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
          const staging = new UploadStagingArea(join(root, ".staging"));
          await staging.prepare();
          try {
            const result = await staging.use((files) =>
              workspaceFileTransfer(directory, files, request, chunks, signal),
            );
            if (loseCompletion && result.state === "ready") {
              loseCompletion = false;
              throw new Error("lost completion response");
            }
            return result;
          } finally {
            await directory.close();
          }
        },
      },
      productionHttpGateway: new ProductionHttpGateway({
        authenticator: new PostgresTenantApiAuthenticator({ database: db }),
        readiness: () => true,
      }),
    });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pc-tus-api-"));
    admin = createDatabase({ connectionString: external!, maxConnections: 1 });
    await sql`create database ${sql.id(databaseName)}`.execute(admin);
    const url = new URL(external!);
    url.pathname = `/${databaseName}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 6 });
    await runMigrations(db, "up");
    tenant = await createPrivateTenant(db, {
      slug: "file-transfers",
      ownerDisplayName: "Transfers",
    });
    store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Transfers", source: { kind: "empty" } });
    workspaceId = project.workspaceId;
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Transfers",
      "elastic",
    );
    sessionId = session.sessionId;
    await start();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (admin) {
      await sql`drop database if exists ${sql.id(databaseName)} with (force)`.execute(admin);
      await admin.destroy();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });
  const url = (id: string) => `${base}/v1/sessions/${sessionId}/workspace-files/${id}`;
  const payload = (name = "data.bin") => ({
    workspaceId,
    workingDirectory: "/workspace",
    name,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const create = (id: string, body = payload()) =>
    fetch(url(id), {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const patch = (id: string, offset: number, chunk: Buffer) =>
    fetch(`${url(id)}/content`, {
      method: "PATCH",
      headers: {
        ...headers(),
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: new Uint8Array(chunk),
    });
  it("creates no retained original, native input or Run, then resumes with the real client", async () => {
    const id = randomUUID();
    const created = await create(id);
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await patch(id, 0, bytes.subarray(0, 7))).status).toBe(204);
    const head = await fetch(`${url(id)}/content`, {
      method: "HEAD",
      headers: { ...headers(), "Tus-Resumable": "1.0.0" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Upload-Offset")).toBe("7");
    expect((await patch(id, 0, bytes.subarray(0, 7))).status).toBe(409);
    await new Promise<void>((resolve, reject) =>
      new TusUpload(bytes, {
        uploadUrl: `${url(id)}/content`,
        headers: headers(),
        chunkSize: 8,
        retryDelays: [],
        onSuccess: () => resolve(),
        onError: reject,
      }).start(),
    );
    const result = (await (await fetch(url(id), { headers: headers() })).json()) as {
      state: string;
    };
    expect(result.state).toBe("ready");
    expect(await readFile(join(root, "uploads", id, "data.bin"))).toEqual(bytes);
    for (const table of ["runs", "session_uploads", "session_attachment_objects"] as const)
      expect((await sql`select 1 from ${sql.table(table)}`.execute(db)).rows).toHaveLength(0);
  });
  it("rejects malformed input and a deleted Workspace before contacting its file receiver", async () => {
    const uppercaseId = randomUUID().toUpperCase();
    const canonical = await create(uppercaseId, {
      ...payload(),
      workspaceId: workspaceId.toUpperCase(),
    });
    expect(canonical.status).toBe(201);
    expect(((await canonical.json()) as { id: string }).id).toBe(uppercaseId.toLowerCase());
    expect((await create(randomUUID(), { ...payload(), byteLength: 0 })).status).toBe(400);
    const id = randomUUID();
    await create(id);
    await db
      .updateTable("workspaces")
      .set({ deleted_at: new Date() })
      .where("id", "=", workspaceId)
      .execute();
    try {
      expect((await create(randomUUID())).status).toBe(409);
      expect((await patch(id, 0, bytes)).status).toBe(404);
      await expect(readFile(join(root, "uploads", id, "data.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await db
        .updateTable("workspaces")
        .set({ deleted_at: null })
        .where("id", "=", workspaceId)
        .execute();
    }
  });
  it("continues after replacing the API process without another authority for offset", async () => {
    const id = randomUUID();
    await create(id);
    await patch(id, 0, bytes.subarray(0, 5));
    await app.close();
    await start();
    expect(
      ((await (await fetch(url(id), { headers: headers() })).json()) as { offset: number }).offset,
    ).toBe(5);
    const completed = await patch(id, 5, bytes.subarray(5));
    expect(completed.status, await completed.text()).toBe(204);
    expect(await readFile(join(root, "uploads", id, "data.bin"))).toEqual(bytes);
  });
  it("reconciles a lost completion without overwriting a subsequently edited file", async () => {
    const id = randomUUID();
    await create(id);
    loseCompletion = true;
    expect((await patch(id, 0, bytes)).status).toBe(500);
    await writeFile(join(root, "uploads", id, "data.bin"), "agent-edited");
    expect(
      ((await (await fetch(url(id), { headers: headers() })).json()) as { state: string }).state,
    ).toBe("ready");
    expect(await readFile(join(root, "uploads", id, "data.bin"), "utf8")).toBe("agent-edited");
    await unlink(join(root, "uploads", id, "data.bin"));
    await create(id);
    await expect(readFile(join(root, "uploads", id, "data.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("cancels partial uploads and rejects a reused identity with different source bytes", async () => {
    const id = randomUUID();
    await create(id);
    await patch(id, 0, bytes.subarray(0, 2));
    expect((await create(id, { ...payload(), sha256: "0".repeat(64) })).status).toBe(409);
    const cancelled = await fetch(url(id), { method: "DELETE", headers: headers() });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect((await patch(id, 2, bytes.subarray(2))).status).toBe(410);
    expect((await create(id)).status).toBe(409);
  });
  it("rejects stale Workspace binding and expired grants, and cleans the physical partial before metadata", async () => {
    const id = randomUUID();
    await create(id);
    await patch(id, 0, bytes.subarray(0, 2));
    expect((await create(randomUUID(), { ...payload(), workspaceId: randomUUID() })).status).toBe(
      409,
    );
    await db
      .updateTable("workspace_file_transfers")
      .set({ expires_at: new Date(0) })
      .where("id", "=", id)
      .execute();
    expect((await fetch(url(id), { headers: headers() })).status).toBe(404);
    await app.get(WorkspaceFileTransferService).reap();
    expect(
      await db.selectFrom("workspace_file_transfers").selectAll().where("id", "=", id).execute(),
    ).toHaveLength(0);
    await expect(
      readFile(join(root, ".staging", "files", `transfer-${id}`, "body")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("queries acceptance without admitting an unconfirmed message", async () => {
    const path = `${base}/v1/sessions/${sessionId}/input-receipt?key=browser-receipt`;
    expect(await (await fetch(path, { headers: headers() })).json()).toEqual({
      status: "unconfirmed",
    });
    expect(await db.selectFrom("runs").select("id").execute()).toHaveLength(0);
    await store.acceptTurn(sessionId, "browser-receipt", { prompt: "Keep this accepted input" });
    expect(await (await fetch(path, { headers: headers() })).json()).toEqual({
      status: "accepted",
    });
    expect(await db.selectFrom("runs").select("id").execute()).toHaveLength(1);
  });
});
