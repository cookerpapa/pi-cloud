import { afterEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { UploadStagingArea } from "../src/upload-staging.ts";
import { registerUploadStaging, reapRegisteredUploads } from "../src/upload-staging-registry.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "upload-staging-"));
  roots.push(root);
  const area = new UploadStagingArea(join(root, "area"));
  await area.prepare();
  return { root, area };
}
const part = () => `.part-${randomUUID()}`;

it("admits another upload while a live writer excludes nonblocking cleanup", async () => {
  const { area } = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const name = part();
  const pending = area.use(async (files) => {
    await writeFile(`/proc/self/fd/${files.fd}/${name}`, "active");
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await area.prepare(); // Already initialized areas must not take an exclusive initialization lock.
    await area.use(async () => {});
    expect(await area.reap()).toEqual({ busy: true, files: 0, bytes: 0 });
    expect(await readFile(join(area.directory, "files", name), "utf8")).toBe("active");
  } finally {
    release.resolve();
    await pending;
  }
  expect(await area.reap()).toEqual({ busy: false, files: 1, bytes: 6 });
});

it.each([false, true])(
  "reclaims a killed registered writer without retry (published=%s)",
  async (published) => {
    const { root, area } = await fixture(),
      registry = join(root, "registry"),
      name = part(),
      target = join(root, "complete.bin");
    const module = new URL("../src/index.ts", import.meta.url).href;
    const code = `import {UploadStagingArea,registerUploadStaging} from ${JSON.stringify(module)};
    import {writeFile,link,open} from 'node:fs/promises';
    const [areaPath,registry,name,target,publish]=process.argv.slice(1);
    const area=new UploadStagingArea(areaPath);await area.prepare();await registerUploadStaging(registry,areaPath);
    await area.use(async files=>{const path='/proc/self/fd/'+files.fd+'/'+name;await writeFile(path,Buffer.alloc(65536,42));
      const file=await open(path);await file.sync();await file.close();
      if(publish==='true') await link(path,target);
      process.stdout.write('ready');await new Promise(resolve=>process.stdin.once('data',resolve));});`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        area.directory,
        registry,
        name,
        target,
        String(published),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    try {
      await vi.waitFor(() => expect(output).toBe("ready"), { timeout: 10000 });
      expect((await reapRegisteredUploads(registry)).files).toBe(0);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      let removed = 0;
      for (let i = 0; i < 3; i++) removed += (await reapRegisteredUploads(registry)).files;
      expect(removed).toBe(1);
      expect(await readdir(join(area.directory, "files"))).toEqual([]);
      if (published) expect(await readFile(target)).toEqual(Buffer.alloc(65536, 42));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
  15000,
);

it("does not let an old filesystem locator authorize a replaced area", async () => {
  const { root, area } = await fixture(),
    registry = join(root, "registry");
  await registerUploadStaging(registry, area.directory);
  await rename(area.directory, join(root, "old"));
  const replacement = new UploadStagingArea(area.directory);
  await replacement.prepare();
  const name = part();
  await replacement.use((files) => writeFile(`/proc/self/fd/${files.fd}/${name}`, "keep"));
  const result = await reapRegisteredUploads(registry);
  expect(result.deferred).toBe(1);
  expect(result.files).toBe(0);
  expect(await readFile(join(area.directory, "files", name), "utf8")).toBe("keep");
});

it("persists cleanup rotation over more areas than one maintenance batch", async () => {
  const { root } = await fixture(),
    registry = join(root, "registry");
  for (let n = 0; n < 5; n++) {
    const area = new UploadStagingArea(join(root, `area-${n}`));
    await area.prepare();
    await registerUploadStaging(registry, area.directory);
    await area.use((files) => writeFile(`/proc/self/fd/${files.fd}/${part()}`, "partial"));
  }
  let removed = 0;
  for (let n = 0; n < 4; n++) removed += (await reapRegisteredUploads(registry, 2)).files;
  expect(removed).toBe(5);
});

it("refuses to adopt unexpected bytes and recovers an interrupted empty initialization", async () => {
  const { root } = await fixture();
  const unsafe = new UploadStagingArea(join(root, "unowned"));
  await mkdir(join(unsafe.directory, "files"), { recursive: true });
  const name = part();
  await writeFile(join(unsafe.directory, "files", name), "user bytes");
  await expect(unsafe.prepare()).rejects.toThrow("Unrecognized");
  expect(await readFile(join(unsafe.directory, "files", name), "utf8")).toBe("user bytes");
  await rm(join(unsafe.directory, "files", name));
  await writeFile(join(unsafe.directory, part()), "interrupted identity");
  await unsafe.prepare();
  await unsafe.use(async () => {});
  expect(await readFile(join(unsafe.directory, "identity"), "utf8")).toBe(
    "pi-cloud-upload-staging-v1\n",
  );
});

it("rejects a waiter after its lock inode is replaced", async () => {
  const { area } = await fixture(),
    hold = await open(join(area.directory, "lock"), constants.O_RDWR);
  const { acquireFileLock } = await import("../src/file-lock.ts");
  await acquireFileLock(hold.fd, false, 1000);
  let called = false;
  const pending = area
    .use(async () => {
      called = true;
    })
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await rename(join(area.directory, "lock"), join(area.directory, "old-lock"));
  await writeFile(join(area.directory, "lock"), "");
  await hold.close();
  expect(await pending).toBeInstanceOf(Error);
  expect(called).toBe(false);
  expect((await lstat(join(area.directory, "old-lock"))).isFile()).toBe(true);
});
