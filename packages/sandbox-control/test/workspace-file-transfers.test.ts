import { TestQuotaVolumeGateway } from "./fixtures/volume-quota.ts";
import { afterEach, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type WorkspaceFileTransferRequest } from "@pi-cloud/protocol";
import { WorkspaceFileTransferError } from "@pi-cloud/workspace-runtime";
import {
  HttpWorkspaceVolumeGateway,
  WorkspaceVolumeGatewayServer,
  workspaceVolumeId,
} from "../src/workspace-volume-gateway.ts";
import { createPluginVolumeFixture } from "./fixtures/plugin-volume.ts";

const roots: string[] = [];
const servers: WorkspaceVolumeGatewayServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pc-transfer-http-"));
  roots.push(root);
  const bytes = Buffer.from("a complete Workspace file");
  const request: WorkspaceFileTransferRequest = {
    fileTransferProtocolVersion: 1,
    type: "workspace.file_transfer",
    requestId: randomUUID(),
    uploadId: randomUUID(),
    claimToken: randomUUID(),
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    workspaceId: randomUUID(),
    rootPath: "",
    name: "file.bin",
    relativePath: "file.bin",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createParents: false,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    action: "create",
  };
  const volumeId = workspaceVolumeId(request);
  await createPluginVolumeFixture(root, { volumeId });
  let allowed = true;
  let unavailable = false;
  const gateway = new TestQuotaVolumeGateway({
    workspaceRoot: root,
    authorizeFileTransfer: async (input) => {
      if (unavailable)
        throw new WorkspaceFileTransferError(
          "transfer_transport",
          "Receiver temporarily unavailable",
          true,
        );
      if (!allowed || input.claimToken !== request.claimToken) throw new Error("Grant revoked");
    },
  });
  const server = new WorkspaceVolumeGatewayServer({
    host: "127.0.0.1",
    port: 0,
    serviceToken: "test-workspace-transfer-service-token-0001",
    gateway,
  });
  servers.push(server);
  const baseUrl = await server.listen();
  const client = new HttpWorkspaceVolumeGateway({
    baseUrl,
    serviceToken: "test-workspace-transfer-service-token-0001",
  });
  const call = (patch: Partial<WorkspaceFileTransferRequest> = {}, body?: Buffer) =>
    client.fileTransfer(
      { ...request, ...patch },
      body
        ? (async function* () {
            yield body;
          })()
        : undefined,
    );
  return {
    root,
    request,
    bytes,
    call,
    revoke: () => {
      allowed = false;
    },
    unavailable: () => {
      unavailable = true;
    },
    file: join(root, `picloud-posix-${volumeId}`, "workspace", "file.bin"),
  };
}
it("streams the same transfer protocol through the existing Volume HTTP adapter", async () => {
  const f = await fixture();
  expect(await f.call()).toMatchObject({ state: "uploading", offset: 0 });
  expect(
    await f.call({ action: "append", offset: 0, chunkLength: 5 }, f.bytes.subarray(0, 5)),
  ).toMatchObject({ offset: 5 });
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.call({ action: "status" })).toMatchObject({ offset: 5 });
  await expect(
    f.call({ action: "append", offset: 0, chunkLength: 5 }, f.bytes.subarray(0, 5)),
  ).rejects.toMatchObject({ code: "transfer_offset" });
  expect(
    await f.call(
      { action: "append", offset: 5, chunkLength: f.bytes.length - 5 },
      f.bytes.subarray(5),
    ),
  ).toMatchObject({ state: "ready", offset: f.bytes.length });
  expect(await readFile(f.file)).toEqual(f.bytes);
});
it("keeps claim revocation effective at the receiving Volume", async () => {
  const f = await fixture();
  await f.call();
  f.revoke();
  await expect(
    f.call({ action: "append", offset: 0, chunkLength: f.bytes.length }, f.bytes),
  ).rejects.toThrow();
  await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves a receiver's retryable failure through its HTTP adapter", async () => {
  const f = await fixture();
  f.unavailable();
  await expect(f.call()).rejects.toMatchObject({ code: "transfer_transport", retryable: true });
});
it("a cancelled transfer cannot be reopened by a delayed create request", async () => {
  const f = await fixture();
  await f.call({ action: "cancel" });
  await expect(f.call()).rejects.toMatchObject({ code: "transfer_cancelled" });
});
