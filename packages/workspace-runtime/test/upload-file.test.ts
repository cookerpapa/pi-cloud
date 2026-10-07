import { constants } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { writeWorkspaceUpload as placeUpload } from "../src/upload-file.ts";

const staging = new WeakMap<Awaited<ReturnType<typeof open>>, Awaited<ReturnType<typeof open>>>();
function writeWorkspaceUpload(
  root: Parameters<typeof placeUpload>[0],
  input: Parameters<typeof placeUpload>[1],
) {
  return placeUpload(root, input, staging.get(root)!);
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "pi-upload-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  cleanups.push(() => root.close());
  const stagingPath = await mkdtemp(join(tmpdir(), "pi-upload-stage-"));
  cleanups.push(() => rm(stagingPath, { recursive: true, force: true }));
  const stage = await open(stagingPath, constants.O_RDONLY | constants.O_DIRECTORY);
  cleanups.push(() => stage.close());
  staging.set(root, stage);
  const bytes = Buffer.from("uploaded bytes\n"),
    id = randomUUID(),
    name = "截图 test.txt";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    path,
    root,
    input: {
      id,
      name,
      bytes,
      sha256,
      byteLength: bytes.length,
      chunks: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    },
  };
}
it("publishes complete bytes once and reconciles concurrent lost-reply retries", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    writeWorkspaceUpload(f.root, f.input),
    writeWorkspaceUpload(f.root, f.input),
  ]);
  expect(a).toEqual(b);
  expect(await readFile(join(f.path, a.relativePath))).toEqual(f.input.bytes);
  expect(await readdir(join(f.path, "uploads", f.input.id))).toEqual([f.input.name]);
  await writeFile(join(f.path, a.relativePath), "changed by user");
  await expect(writeWorkspaceUpload(f.root, f.input)).rejects.toThrow("different content");
  expect(await readFile(join(f.path, a.relativePath), "utf8")).toBe("changed by user");
});
it("refuses symlinked upload directories and destination files", async () => {
  const f = await fixture(),
    outside = await fixture();
  await symlink(outside.path, join(f.path, "uploads"));
  await expect(writeWorkspaceUpload(f.root, f.input)).rejects.toThrow();
  expect(await readdir(outside.path)).toEqual([]);
  await rm(join(f.path, "uploads"));
  const done = await writeWorkspaceUpload(f.root, f.input);
  await rm(join(f.path, done.relativePath));
  const secret = join(outside.path, "private");
  await writeFile(secret, f.input.bytes);
  await symlink(secret, join(f.path, done.relativePath));
  await expect(writeWorkspaceUpload(f.root, f.input)).rejects.toThrow();
  expect(await readFile(secret)).toEqual(f.input.bytes);
});
it("rejects invalid identities, bytes and cancelled writes before creating a file", async () => {
  const f = await fixture();
  for (const change of [{ name: "../escape" }, { id: "../id" }, { sha256: "0".repeat(64) }])
    await expect(writeWorkspaceUpload(f.root, { ...f.input, ...change })).rejects.toThrow();
  await expect(
    writeWorkspaceUpload(f.root, { ...f.input, signal: AbortSignal.abort(new Error("cancelled")) }),
  ).rejects.toThrow("cancelled");
  expect(await readdir(join(f.path, "uploads", f.input.id))).toEqual([]);
});

it("streams a 65 MiB file, rejects truncation and removes a cancelled partial file", async () => {
  const f = await fixture();
  const chunk = Buffer.alloc(64 * 1024, 0x63),
    count = 1040;
  const digest = createHash("sha256");
  for (let i = 0; i < count; i++) digest.update(chunk);
  const identity = {
    id: randomUUID(),
    name: "large.bin",
    byteLength: count * chunk.length,
    sha256: digest.digest("hex"),
  };
  let produced = 0;
  const chunks = {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < count; i++) {
        produced++;
        yield chunk;
      }
    },
  };
  const result = await writeWorkspaceUpload(f.root, { ...identity, chunks });
  expect(result.byteLength).toBe(65 * 1024 * 1024);
  expect(produced).toBe(count);
  const file = await open(join(f.path, result.relativePath));
  const actual = createHash("sha256");
  try {
    for await (const block of file.createReadStream({ autoClose: false })) actual.update(block);
  } finally {
    await file.close();
  }
  expect(actual.digest("hex")).toBe(identity.sha256);
  for (const byteLength of [identity.byteLength - 1, identity.byteLength + 1]) {
    const id = randomUUID();
    await expect(
      writeWorkspaceUpload(f.root, { ...identity, id, byteLength, chunks }),
    ).rejects.toThrow();
    expect(await readdir(join(f.path, "uploads", id))).toEqual([]);
  }
  const abort = new AbortController(),
    id = randomUUID();
  await expect(
    writeWorkspaceUpload(f.root, {
      ...identity,
      id,
      signal: abort.signal,
      chunks: (async function* () {
        yield chunk;
        abort.abort(new Error("cancel during transfer"));
        yield chunk;
      })(),
    }),
  ).rejects.toThrow("cancel during transfer");
  expect(await readdir(join(f.path, "uploads", id))).toEqual([]);
});
