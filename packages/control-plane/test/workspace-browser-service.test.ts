import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import {
  ConversationArchiveService,
  ControlPlaneStore,
  WorkspaceBrowserService,
  createPrivateTenant,
} from "../src/index.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let store: ControlPlaneStore;
let tenant: Awaited<ReturnType<typeof createPrivateTenant>>;
let sessionId: string;
let workspaceId: string;

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  tenant = await createPrivateTenant(database, {
    slug: "workspace-browser",
    ownerDisplayName: "Workspace Browser",
  });
  store = new ControlPlaneStore({
    database,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
  const project = await store.createProject({ name: "Live Workspace", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Live browser",
    "elastic",
  );
  sessionId = session.sessionId;
  workspaceId = project.workspaceId;
});

afterAll(async () => {
  await database.destroy();
  await socket.stop();
  await pglite.close();
});

describe.sequential("live Workspace browser", () => {
  it("lists one current directory and reads one current file without a historical catalog", async () => {
    const listWorkspaceDirectory = vi.fn(async (request) => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "workspace.directory_listed" as const,
      requestId: request.requestId,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      path: request.path,
      entries: [
        { name: "src", path: "src", kind: "directory" as const },
        {
          name: "README.md",
          path: "README.md",
          kind: "file" as const,
          sizeBytes: 8,
          executable: false,
        },
      ],
      truncated: false,
    }));
    const readWorkspaceFile = vi.fn(async (request) => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "workspace.file_read" as const,
      requestId: request.requestId,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      path: request.path,
      content: Buffer.from("current\n").toString("base64"),
      sha256: "a".repeat(64),
      executable: false,
      sizeBytes: 8,
    }));
    const service = new WorkspaceBrowserService({
      database,
      browser: { listWorkspaceDirectory, readWorkspaceFile },
      idGenerator: randomUUID,
    });
    await expect(service.directory(tenant.tenantId, sessionId, "")).resolves.toMatchObject({
      sessionId,
      workspaceId,
      path: "",
      entries: [{ path: "src" }, { path: "README.md" }],
    });
    await expect(
      service.file(tenant.tenantId, sessionId, "README.md", 512 * 1_024),
    ).resolves.toMatchObject({
      bytes: Buffer.from("current\n"),
      executable: false,
    });
    expect(listWorkspaceDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "", path: "" }),
    );
    expect(readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "", path: "README.md" }),
    );
    await expect(service.directory(tenant.tenantId, sessionId, "../private")).rejects.toMatchObject(
      {
        code: "invalid_path",
      },
    );
  });

  it("archives a conversation idempotently without coupling it to file versions", async () => {
    await database
      .updateTable("sessions")
      .set({ state: "failed" })
      .where("tenant_id", "=", tenant.tenantId)
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const archive = new ConversationArchiveService({ database, idGenerator: randomUUID });
    await expect(
      archive.archive(tenant.tenantId, "archive-live-browser", sessionId, { archived: true }),
    ).resolves.toMatchObject({ kind: "archive", replayed: false });
    await expect(
      archive.archive(tenant.tenantId, "archive-live-browser", sessionId, { archived: true }),
    ).resolves.toMatchObject({ kind: "archive", replayed: true });
    await expect(
      store.acceptTurn(sessionId, "archived-turn", { prompt: "must reject" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
