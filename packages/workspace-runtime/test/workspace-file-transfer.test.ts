import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  open,
  readFile,
  writeFile,
  rm,
  rename,
  unlink,
  mkdir,
  opendir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { UploadStagingArea } from "../src/upload-staging.ts";
import { workspaceFileTransfer } from "../src/workspace-file-transfer.ts";
import type { WorkspaceFileTransferRequest } from "@pi-cloud/protocol/transfers";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(content = Buffer.from("abcdefghijk")) {
  const directory = await mkdtemp(join(tmpdir(), "pc-transfer-"));
  cleanup.push(directory);
  const area = new UploadStagingArea(join(directory, ".staging"));
  await area.prepare();
  const input: WorkspaceFileTransferRequest = {
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
    byteLength: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createParents: false,
    action: "create",
  };
  const execute = async (
    change: Partial<WorkspaceFileTransferRequest> = {},
    chunks?: AsyncIterable<Uint8Array>,
  ) => {
    const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      return await area.use((staging) =>
        workspaceFileTransfer(root, staging, { ...input, ...change }, chunks),
      );
    } finally {
      await root.close();
    }
  };
  const append = (offset: number, data: Buffer) =>
    execute(
      { action: "append", offset, chunkLength: data.length },
      (async function* () {
        yield data;
      })(),
    );
  const metadata = join(area.directory, "files", `transfer-${input.uploadId}`, "metadata");
  return { directory, area, input, content, execute, append, metadata };
}
describe("filesystem-owned resumable Workspace files", () => {
  it("rotates cleanup past unexpired transfers instead of starving a later expired body", async () => {
    const f = await fixture();
    const names: string[] = [];
    await f.area.use(async (directory) => {
      for (let i = 0; i < 8; i++) {
        const name = `transfer-${randomUUID()}`,
          path = `/proc/self/fd/${directory.fd}/${name}`;
        names.push(name);
        await mkdir(path);
        await writeFile(
          `${path}/metadata`,
          JSON.stringify({
            identity: "fixture",
            root: "root",
            parent: "parent",
            state: "uploading",
            expiresAt: Date.now() + 86400000,
          }),
        );
        await writeFile(`${path}/body`, "data");
      }
      const entries = await opendir(`/proc/self/fd/${directory.fd}`);
      const ordered: string[] = [];
      for await (const entry of entries) ordered.push(entry.name);
      const path = `/proc/self/fd/${directory.fd}/${ordered.at(-1)}/metadata`;
      await writeFile(
        path,
        JSON.stringify({
          identity: "fixture",
          root: "root",
          parent: "parent",
          state: "uploading",
          expiresAt: 1,
        }),
      );
    });
    let removed = 0;
    for (let i = 0; i < 6; i++) removed += (await f.area.reap(2)).files;
    expect(removed).toBe(1);
  });
  it("resumes with fresh handles and publishes only complete verified bytes", async () => {
    const f = await fixture();
    await f.execute();
    expect(await f.append(0, f.content.subarray(0, 3))).toMatchObject({
      offset: 3,
      state: "uploading",
    });
    await expect(readFile(join(f.directory, "file.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.execute({ action: "status" })).toMatchObject({ offset: 3 });
    await expect(f.append(0, f.content.subarray(0, 3))).rejects.toMatchObject({
      code: "transfer_offset",
    });
    expect(await f.append(3, f.content.subarray(3))).toMatchObject({ offset: 11, state: "ready" });
    expect(await readFile(join(f.directory, "file.bin"))).toEqual(f.content);
  });
  it("keeps partial progress after a stream interruption", async () => {
    const f = await fixture();
    await f.execute();
    await expect(
      f.execute(
        { action: "append", offset: 0, chunkLength: 5 },
        (async function* () {
          yield f.content.subarray(0, 2);
          throw new Error("connection lost");
        })(),
      ),
    ).rejects.toThrow("connection lost");
    expect(await f.execute({ action: "status" })).toMatchObject({ offset: 2 });
    await f.append(2, f.content.subarray(2));
    expect(await readFile(join(f.directory, "file.bin"))).toEqual(f.content);
  });
  it("does not recreate or overwrite a completed user file on lost-receipt retries", async () => {
    const f = await fixture();
    await f.execute();
    await f.append(0, f.content);
    await writeFile(join(f.directory, "file.bin"), "user changed this");
    expect(await f.execute()).toMatchObject({ state: "ready" });
    expect(await readFile(join(f.directory, "file.bin"), "utf8")).toBe("user changed this");
    await unlink(join(f.directory, "file.bin"));
    expect(await f.execute({ action: "status" })).toMatchObject({ state: "ready" });
    await expect(readFile(join(f.directory, "file.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects wrong sources and never publishes checksum failures", async () => {
    const f = await fixture();
    await f.execute();
    await expect(f.execute({ sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "transfer_identity",
    });
    await expect(f.append(0, Buffer.alloc(f.content.length))).rejects.toMatchObject({
      code: "transfer_content",
    });
    await expect(f.execute({ action: "status" })).rejects.toMatchObject({
      code: "transfer_content",
    });
    await expect(readFile(join(f.directory, "file.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not overwrite an existing file", async () => {
    const f = await fixture();
    await f.execute();
    await writeFile(join(f.directory, "file.bin"), "existing");
    await expect(f.append(0, f.content)).rejects.toMatchObject({ code: "transfer_conflict" });
    expect(await readFile(join(f.directory, "file.bin"), "utf8")).toBe("existing");
  });
  it("cancellation fences a delayed create and cleans only unfinished bytes", async () => {
    const f = await fixture();
    await f.execute();
    await f.append(0, f.content.subarray(0, 2));
    expect(await f.execute({ action: "cancel" })).toMatchObject({ state: "cancelled" });
    await expect(f.execute()).rejects.toMatchObject({ code: "transfer_cancelled" });
    const ready = await fixture();
    await ready.execute();
    await ready.append(0, ready.content);
    expect(await ready.execute({ action: "cancel" })).toMatchObject({ state: "ready" });
    expect(await readFile(join(ready.directory, "file.bin"))).toEqual(ready.content);
  });
  it("keeps unexpired paused transfers and reaps expired staging without deleting output", async () => {
    const f = await fixture();
    await f.execute();
    await f.append(0, f.content.subarray(0, 2));
    expect((await f.area.reap()).files).toBe(0);
    const meta = JSON.parse(await readFile(f.metadata, "utf8"));
    await writeFile(f.metadata, JSON.stringify({ ...meta, expiresAt: Date.now() - 1 }));
    expect(await f.area.reap()).toMatchObject({ files: 1, bytes: 2 });
    await expect(f.execute({ action: "status" })).rejects.toMatchObject({
      code: "transfer_missing",
    });
  });
  it("refuses to retarget a replacement destination directory", async () => {
    const f = await fixture();
    f.input.relativePath = `uploads/${f.input.uploadId}/file.bin`;
    f.input.createParents = true;
    await f.execute();
    await rename(join(f.directory, "uploads", f.input.uploadId), join(f.directory, "previous"));
    await expect(f.append(0, f.content)).rejects.toMatchObject({ code: "transfer_path" });
  });
  it("does not guess whether an interrupted publication should be repeated", async () => {
    const f = await fixture();
    await f.execute();
    const base = join(f.area.directory, "files", `transfer-${f.input.uploadId}`);
    await writeFile(join(base, "body"), f.content);
    const meta = JSON.parse(await readFile(f.metadata, "utf8"));
    await writeFile(f.metadata, JSON.stringify({ ...meta, state: "publishing", inode: "unknown" }));
    await expect(f.execute({ action: "status" })).rejects.toMatchObject({
      code: "transfer_uncertain",
    });
    await expect(readFile(join(f.directory, "file.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
