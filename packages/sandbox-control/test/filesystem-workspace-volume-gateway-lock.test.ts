import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
  readdir,
  readlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
  FilesystemWorkspaceVolumeGatewayLock,
  PersistentVolumeWorkspaceVolumeGateway,
  workspaceVolumeId,
  type WorkspaceVolumeLockScope,
} from "../src/index.ts";
import { createPluginVolumeFixture } from "./fixtures/plugin-volume.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-volume-flock-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), sessionId: randomUUID() };
  const volumeId = workspaceVolumeId(scope),
    path = join(root, `picloud-posix-${volumeId}`);
  await createPluginVolumeFixture(root, { volumeId });
  return {
    root,
    path,
    scope: { ...scope, volumeId },
    lock: () => new FilesystemWorkspaceVolumeGatewayLock(root, 2000),
  };
}
async function holdInChild(
  root: string,
  volumeId: string,
  scope: WorkspaceVolumeLockScope = "exclusive",
) {
  const module = new URL("../src/filesystem-workspace-volume-gateway-lock.ts", import.meta.url)
    .href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {FilesystemWorkspaceVolumeGatewayLock} from ${JSON.stringify(module)};
    await new FilesystemWorkspaceVolumeGatewayLock(${JSON.stringify(root)}).withLock(${JSON.stringify(volumeId)},${JSON.stringify(scope)},async()=>{
      process.stdout.write('held\\n');
      await new Promise(resolve=>process.stdin.once('data',resolve));
    });process.exit(0);
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGKILL");
      await closed;
    }
  });
  let output = "",
    error = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    error += chunk;
  });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null) throw new Error(error);
      expect(output).toContain("held\n");
    },
    { timeout: 10000 },
  );
  return child;
}
async function stop(child: ChildProcess, signal?: NodeJS.Signals) {
  const exited = once(child, "exit");
  if (signal) child.kill(signal);
  else child.stdin!.end("release");
  await exited;
}

it.each([
  ["exclusive", "normal"],
  ["exclusive", "SIGKILL"],
  ["shared", "normal"],
  ["shared", "SIGKILL"],
  ["credentials", "SIGKILL"],
] as const)(
  "holds %s exclusion across utility exit and releases after holder %s",
  async (scope, mode) => {
    const f = await fixture(),
      child = await holdInChild(f.root, f.scope.volumeId, scope);
    if (scope !== "exclusive")
      expect(await f.lock().withLock(f.scope.volumeId, "shared", async () => "reader")).toBe(
        "reader",
      );
    if (scope === "shared")
      expect(
        await f.lock().withLock(f.scope.volumeId, "credentials", async () => "credential"),
      ).toBe("credential");
    let entered = false;
    const waiter = f.lock().withLock(f.scope.volumeId, "exclusive", async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entered).toBe(false);
    const other = { volumeId: workspaceVolumeId({ ...f.scope, workspaceId: randomUUID() }) };
    await createPluginVolumeFixture(f.root, other);
    await f.lock().withLock(other.volumeId, "exclusive", async () => "independent");
    await stop(child, mode === "SIGKILL" ? "SIGKILL" : undefined);
    await waiter;
    expect(entered).toBe(true);
  },
);

it.each(["shared", "credentials", "exclusive"] as const)(
  "never runs after %s acquisition timeout and releases a failed callback's lock",
  async (scope) => {
    const f = await fixture(),
      child = await holdInChild(f.root, f.scope.volumeId),
      callback = vi.fn();
    await expect(
      new FilesystemWorkspaceVolumeGatewayLock(f.root, 30).withLock(
        f.scope.volumeId,
        scope,
        callback,
      ),
    ).rejects.toMatchObject({ code: "workspace_volume_lock_unavailable" });
    expect(callback).not.toHaveBeenCalled();
    await stop(child);
    await expect(
      f.lock().withLock(f.scope.volumeId, scope, async () => {
        throw new Error("file failed");
      }),
    ).rejects.toThrow("file failed");
    expect(await f.lock().withLock(f.scope.volumeId, "exclusive", async () => "next")).toBe("next");
  },
);

it.each(["exclusive", "shared", "credentials"] as const)(
  "rejects a %s waiter whose locked envelope was replaced",
  async (scope) => {
    const f = await fixture(),
      child = await holdInChild(f.root, f.scope.volumeId),
      callback = vi.fn();
    const waiting = f
      .lock()
      .withLock(f.scope.volumeId, scope, callback)
      .catch((error) => error);
    await vi.waitFor(async () => {
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => ""),
        ),
      );
      expect(targets).toContain(join(f.path, ".pi-cloud-runtime/gateway.lock"));
    });
    await rename(f.path, `${f.path}.retired`);
    await createPluginVolumeFixture(f.root, f.scope);
    await f.lock().withLock(f.scope.volumeId, "exclusive", async () => {});
    await stop(child);
    expect(await waiting).toMatchObject({ code: "workspace_volume_binding_invalid" });
    expect(callback).not.toHaveBeenCalled();
  },
);

it("rejects a credential waiter whose inner lock inode was replaced", async () => {
  const f = await fixture(),
    child = await holdInChild(f.root, f.scope.volumeId, "credentials"),
    callback = vi.fn();
  const path = join(f.path, ".pi-cloud-runtime/credentials.lock");
  const waiting = f
    .lock()
    .withLock(f.scope.volumeId, "credentials", callback)
    .catch((error) => error);
  await vi.waitFor(async () => {
    const targets = await Promise.all(
      (await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
    );
    expect(targets).toContain(path);
  });
  await rename(path, path + ".retired");
  await writeFile(path, "", { mode: 0o600 });
  await stop(child);
  expect(await waiting).toMatchObject({ code: "workspace_volume_binding_invalid" });
  expect(callback).not.toHaveBeenCalled();
});

it("permits actual browsing, another upload and credential updates during an upload, but excludes deletion", async () => {
  const f = await fixture(),
    release = Promise.withResolvers<void>(),
    began = Promise.withResolvers<void>();
  const gateway = () =>
    new PersistentVolumeWorkspaceVolumeGateway({
      workspaceRoot: f.root,
      lock: f.lock(),
      authorizeUpload: async () => {},
    });
  const first = gateway(),
    second = gateway();
  const request = (name: string, content: string) => ({
    ...f.scope,
    uploadId: randomUUID(),
    claimToken: randomUUID(),
    name,
    rootPath: "",
    byteLength: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const upload = first.uploadFile(
    request("slow.txt", "ab"),
    (async function* () {
      yield Buffer.from("a");
      began.resolve();
      await release.promise;
      yield Buffer.from("b");
    })(),
  );
  let deletion: Promise<unknown> | undefined,
    deleted = false;
  try {
    await began.promise;
    // One instance as well as another: no hidden process-local serial queue.
    await first.listDirectory({ ...f.scope, rootPath: "", path: "" });
    const quick = request("quick.txt", "ready");
    const receipt = await second.uploadFile(
      quick,
      (async function* () {
        yield Buffer.from("ready");
      })(),
    );
    expect(
      Buffer.from(
        (
          await second.readFile({
            ...f.scope,
            rootPath: "",
            path: receipt.relativePath,
            maximumBytes: 100,
          })
        ).bytes,
      ).toString(),
    ).toBe("ready");
    const credential = {
      ...f.scope,
      requestId: randomUUID(),
      provider: "gitlab" as const,
      origin: "https://git.example.test",
      accessToken: "fixture-token-never-used",
      credentialMountPath: "/workspace" as const,
    };
    await second.authorizeSourceCredential(credential);
    expect((await first.listSourceCredentials(credential)).connections).toHaveLength(1);
    deletion = second.prepareDelete(f.scope).then(() => {
      deleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deleted).toBe(false);
    release.resolve();
    await upload;
    await deletion;
    await expect(first.listDirectory({ ...f.scope, rootPath: "", path: "" })).rejects.toMatchObject(
      { code: "workspace_volume_deleting" },
    );
  } finally {
    release.resolve();
    await upload.catch(() => {});
    await deletion;
  }
});

it("publishes identical concurrent uploads once and rejects conflicting content without overwrite", async () => {
  const f = await fixture();
  const gateways = [0, 1].map(
    () =>
      new PersistentVolumeWorkspaceVolumeGateway({
        workspaceRoot: f.root,
        authorizeUpload: async () => {},
      }),
  );
  const input = {
    ...f.scope,
    uploadId: randomUUID(),
    claimToken: randomUUID(),
    name: "same.txt",
    rootPath: "",
    byteLength: 3,
    sha256: createHash("sha256").update("one").digest("hex"),
  };
  const bytes = async function* (text: string) {
    yield Buffer.from(text);
  };
  const replies = await Promise.all(gateways.map((g) => g.uploadFile(input, bytes("one"))));
  expect(replies[0]).toEqual(replies[1]);
  await expect(
    gateways[1]!.uploadFile(
      { ...input, sha256: createHash("sha256").update("two").digest("hex") },
      bytes("two"),
    ),
  ).rejects.toThrow();
  expect(
    Buffer.from(
      (
        await gateways[0]!.readFile({
          ...f.scope,
          rootPath: "",
          path: replies[0]!.relativePath,
          maximumBytes: 10,
        })
      ).bytes,
    ).toString(),
  ).toBe("one");
});

it("does not initialize absent/unpublished Volumes and keeps deletion retryable", async () => {
  const f = await fixture(),
    gateway = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot: f.root, lock: f.lock() });
  await rm(f.path, { recursive: true });
  await expect(gateway.verify(f.scope)).rejects.toMatchObject({
    code: "workspace_volume_identity_unavailable",
  });
  expect(await readdir(f.root)).toEqual([]);
  expect(await gateway.prepareDelete(f.scope)).toEqual({ prepared: false });
  expect(await gateway.finalizeDelete(f.scope)).toEqual({ deleted: false });
  await mkdir(join(f.path, ".pi-cloud-runtime"), { recursive: true });
  await expect(gateway.verify(f.scope)).rejects.toBeDefined();
  expect(await readdir(join(f.path, ".pi-cloud-runtime"))).toEqual([]);
  await expect(gateway.prepareDelete(f.scope)).rejects.toBeDefined();
});

it("serializes actual credential updates across Gateways and removes locks with retired envelopes", async () => {
  const f = await fixture(),
    gateways = Array.from(
      { length: 2 },
      () => new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot: f.root, lock: f.lock() }),
    );
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      gateways[i % 2]!.authorizeSourceCredential({
        ...f.scope,
        requestId: randomUUID(),
        provider: "gitlab",
        origin: `https://git${i}.example.test`,
        accessToken: "fixture-token-never-used",
        credentialMountPath: "/workspace",
      }),
    ),
  );
  const connections = await gateways[0]!.listSourceCredentials({
    ...f.scope,
    requestId: randomUUID(),
    credentialMountPath: "/workspace",
  });
  expect(connections.connections).toHaveLength(8);
  await gateways[0]!.prepareDelete(f.scope);
  await expect(gateways[1]!.verify(f.scope)).rejects.toMatchObject({
    code: "workspace_volume_deleting",
  });
  await rm(join(f.path, "workspace"), { recursive: true });
  expect(await gateways[0]!.finalizeDelete(f.scope)).toEqual({ deleted: true });
  expect(await gateways[1]!.finalizeDelete(f.scope)).toEqual({ deleted: false });
  expect(await readdir(f.root)).toEqual([]);
});

it
  .skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
  .each(["exclusive", "credentials"] as const)(
  "keeps %s filesystem exclusion while a callback continues after PG connection loss",
  async (scope) => {
    const f = await fixture(),
      pool = new Pool({ connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, max: 2 });
    cleanups.push(() => pool.end());
    const connection = await pool.connect(),
      observer = await pool.connect();
    connection.on("error", () => {});
    const disconnected = once(connection, "error").then(() => undefined);
    const pid = (await connection.query("select pg_backend_pid() pid")).rows[0].pid;
    const ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const path = join(f.path, "workspace/state.json");
    await writeFile(path, "[]");
    const old = f.lock().withLock(f.scope.volumeId, scope, async () => {
      const value = JSON.parse(await readFile(path, "utf8"));
      ready.resolve();
      await release.promise;
      await writeFile(path, JSON.stringify([...value, "old"]));
    });
    let entered = false,
      next: Promise<void> | undefined;
    try {
      await ready.promise;
      await observer.query("select pg_terminate_backend($1)", [pid]);
      await disconnected;
      next = f.lock().withLock(f.scope.volumeId, scope, async () => {
        entered = true;
        const value = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify([...value, "new"]));
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entered).toBe(false);
    } finally {
      release.resolve();
      await old;
      await next;
      connection.release(true);
      observer.release();
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(["old", "new"]);
  },
);
