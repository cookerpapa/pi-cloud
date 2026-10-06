import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
async function holdInChild(root: string, volumeId: string) {
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
    await new FilesystemWorkspaceVolumeGatewayLock(${JSON.stringify(root)}).withLock(${JSON.stringify(volumeId)},async()=>{
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

it.each(["normal", "SIGKILL"] as const)(
  "holds the filesystem lock across utility exit and releases after holder %s",
  async (mode) => {
    const f = await fixture(),
      child = await holdInChild(f.root, f.scope.volumeId);
    let entered = false;
    const waiter = f.lock().withLock(f.scope.volumeId, async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entered).toBe(false);
    const other = { volumeId: workspaceVolumeId({ ...f.scope, workspaceId: randomUUID() }) };
    await createPluginVolumeFixture(f.root, other);
    await f.lock().withLock(other.volumeId, async () => "independent");
    await stop(child, mode === "SIGKILL" ? "SIGKILL" : undefined);
    await waiter;
    expect(entered).toBe(true);
  },
);

it("never runs after acquisition timeout and releases a failed callback's lock", async () => {
  const f = await fixture(),
    child = await holdInChild(f.root, f.scope.volumeId),
    callback = vi.fn();
  await expect(
    new FilesystemWorkspaceVolumeGatewayLock(f.root, 30).withLock(f.scope.volumeId, callback),
  ).rejects.toMatchObject({ code: "workspace_volume_lock_unavailable" });
  expect(callback).not.toHaveBeenCalled();
  await stop(child);
  await expect(
    f.lock().withLock(f.scope.volumeId, async () => {
      throw new Error("file failed");
    }),
  ).rejects.toThrow("file failed");
  expect(await f.lock().withLock(f.scope.volumeId, async () => "next")).toBe("next");
});

it("rejects a waiter whose locked envelope was replaced", async () => {
  const f = await fixture(),
    child = await holdInChild(f.root, f.scope.volumeId),
    callback = vi.fn();
  const waiting = f
    .lock()
    .withLock(f.scope.volumeId, callback)
    .catch((error) => error);
  await vi.waitFor(async () => {
    const targets = await Promise.all(
      (await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
    );
    expect(targets).toContain(join(f.path, ".pi-cloud-runtime/gateway.lock"));
  });
  await rename(f.path, `${f.path}.retired`);
  await createPluginVolumeFixture(f.root, f.scope);
  await f.lock().withLock(f.scope.volumeId, async () => {});
  await stop(child);
  expect(await waiting).toMatchObject({ code: "workspace_volume_binding_invalid" });
  expect(callback).not.toHaveBeenCalled();
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

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "keeps filesystem exclusion while a callback continues after PG connection loss",
  async () => {
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
    const old = f.lock().withLock(f.scope.volumeId, async () => {
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
      next = f.lock().withLock(f.scope.volumeId, async () => {
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
