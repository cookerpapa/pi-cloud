import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rename,
  rm,
  cp,
  truncate,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  inspectWorkspaceStoragePool,
  normalizeWorkspacePoolPlan,
  prepareWorkspaceStoragePool,
  verifyWorkspaceStoragePool,
  growWorkspaceStoragePool,
  workspacePoolPaths,
  workspacePoolSystemdFiles,
} from "./workspace-storage-pool.mjs";
import { assertWorkspaceStorageProcessesStopped } from "./workspace-storage-pool-guard.mjs";

const directories = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const GiB = 1024 ** 3;
async function exists(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "pi-pool-contract-"));
  directories.push(root);
  const runtimeDirectory = join(root, "runtime"),
    paths = workspacePoolPaths(runtimeDirectory);
  await mkdir(paths.canonical, { recursive: true, mode: 0o750 });
  const workspaces = normalizeWorkspacePoolPlan(
    Array.from({ length: count }, () => ({
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      generation: "a".repeat(64),
      revision: 1,
      capacityBytes: 32 * GiB,
    })),
  );
  for (const [index, entry] of workspaces.entries()) {
    const base = join(paths.canonical, `picloud-posix-${entry.volumeId}`);
    await mkdir(join(base, "workspace"), { recursive: true });
    await mkdir(join(base, ".pi-cloud-runtime/uploads-v1/files"), { recursive: true });
    await writeFile(
      join(base, ".pi-cloud-runtime/identity"),
      `pi-cloud-volume-v1\n${entry.volumeId}\n${entry.generation}\n`,
    );
    await writeFile(join(base, "workspace/original.txt"), `original Workspace ${index}\n`);
    await writeFile(
      join(base, ".pi-cloud-runtime/uploads-v1/files/partial"),
      `partial upload ${index}\n`,
    );
  }
  const tokenFile = join(root, "workspace-volume-gateway-token"),
    meteringTokenFile = join(root, "metering-ingest-token");
  await writeFile(tokenFile, "fixture-service-key", { mode: 0o600 });
  await writeFile(meteringTokenFile, "fixture-metering-key", { mode: 0o600 });
  const options = {
    runtimeDirectory,
    sourceId: "workspace:local",
    workspaces,
    poolBytes: 64 * GiB,
    quotaHelper: {
      binary: "/opt/pi-cloud/workspace-quota",
      tokenFile,
      meteringTokenFile,
      meteringUrl: "http://127.0.0.1:3000/internal/v1/resource-metering",
      listen: "127.0.0.1:14510",
    },
    assertQuiescent: vi.fn(async () => ({
      runtimeQuiescent: true,
      physicalVMsAbsent: true,
      schemaVersion: 212,
    })),
  };
  const mounts = new Map(),
    commands = [],
    projects = new Map();
  let imageUUID,
    helperRoot,
    helperAlive = false,
    failAfter,
    wrongUUID = false,
    wrongProject = false,
    refuseStop = false,
    corruptData = false;
  const fsDirectory = join(root, "filesystem"),
    systemDirectory = join(root, "systemd"),
    verifierDirectory = join(root, "libexec");
  const state = async () => JSON.parse(await readFile(paths.journal, "utf8"));
  const mount = async (target) => {
    expect(await readdir(target)).toEqual([]);
    await rm(target, { recursive: true });
    await rename(fsDirectory, target);
    mounts.set(target, {
      target,
      source: "/dev/loop99",
      fstype: "xfs",
      options: "rw,prjquota,nosuid,nodev",
      uuid: imageUUID,
    });
  };
  async function compare(source, target) {
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!(await exists(join(target, item.name)))) return false;
        if (!(await compare(join(source, item.name), join(target, item.name)))) return false;
      } else if (
        !(await exists(join(target, item.name))) ||
        !(await readFile(join(source, item.name))).equals(await readFile(join(target, item.name)))
      )
        return false;
    }
    return true;
  }
  const run = vi.fn(async (command, args, execution = {}) => {
    commands.push({ command, args, lockFd: execution.lockFd });
    let stdout = "",
      code = 0,
      operation = command;
    if (command === "findmnt") {
      const value = mounts.get(args[args.indexOf("--mountpoint") + 1]);
      if (value)
        stdout = JSON.stringify({
          filesystems: [{ ...value, uuid: wrongUUID ? randomUUID() : value.uuid }],
        });
      else code = 1;
    } else if (command === "du") stdout = `4096\t${args.at(-1)}\n`;
    else if (command === "flock") expect(execution.lockFd).toBeTypeOf("number");
    else if (command === "losetup") {
      if (args[0] === "--set-capacity") operation = "set-capacity";
      else
        stdout = JSON.stringify({
          loopdevices: mounts.size ? [{ name: "/dev/loop99", "back-file": paths.image }] : [],
        });
    } else if (command === "blkid") {
      code = imageUUID ? 0 : 2;
      stdout = imageUUID ? `UUID=${imageUUID}\nTYPE=xfs\n` : "";
    } else if (command === "truncate") await truncate(args.at(-1), Number(args[1]));
    else if (command === "mkfs.xfs") {
      imageUUID = args[2].slice(5);
      await mkdir(fsDirectory, { recursive: true });
    } else if (command === "mount") await mount(args.at(-1));
    else if (command === "umount") {
      expect(helperAlive).toBe(false);
      await rename(args[0], fsDirectory);
      await mkdir(args[0]);
      mounts.delete(args[0]);
    } else if (command === "systemd-escape") stdout = "fixture-volume.mount\n";
    else if (command === "systemd-run") {
      helperRoot = args
        .find((value) => value.startsWith("--setenv=PI_CLOUD_WORKSPACE_POSIX_ROOT="))
        .split("=")
        .slice(2)
        .join("=");
      helperAlive = true;
      operation = "helper-start";
    } else if (command === "systemctl") {
      if (args[0] === "show")
        stdout = helperAlive
          ? "LoadState=loaded\nActiveState=active\nMainPID=123\nControlPID=0\n"
          : "LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlPID=0\n";
      else if (args[0] === "stop") {
        if (!refuseStop) helperAlive = false;
        operation = "helper-stop";
      } else if (args[0] === "start") {
        await mount(paths.canonical);
        operation = "canonical-mount";
      }
    } else if (command === "rsync") {
      const source = args.at(-2).replace(/\/$/, ""),
        target = args.at(-1).replace(/\/$/, "");
      expect(args.slice(0, 2)).toEqual(["-aHAXS", "--numeric-ids"]);
      if (args.includes("--dry-run")) {
        stdout = (await compare(source, target)) ? "" : ">fcs....... changed\n";
        operation = "checksum";
      } else {
        await cp(source, target, { recursive: true, force: true, preserveTimestamps: true });
        operation = "copy";
        if (corruptData) {
          corruptData = false;
          await writeFile(
            join(target, `picloud-posix-${workspaces[0].volumeId}/workspace/original.txt`),
            "corrupt",
          );
        }
      }
    } else if (command === "xfs_io") {
      const id = args.at(-1).match(/picloud-posix-(pcw-[0-9a-f]{48})/)[1];
      stdout = `fsxattr.projid = ${wrongProject ? 999 : projects.get(id).projectId}\nfsxattr.xflags = 0x200 [proj-inherit]\n`;
    } else if (command === "rm") {
      expect(helperAlive).toBe(false);
      expect(mounts.has(paths.canonical)).toBe(true);
      expect(args.slice(0, 3)).toEqual(["--recursive", "--one-file-system", "--preserve-root"]);
      if (failAfter === "partial-delete") {
        failAfter = undefined;
        await rm(
          join(args.at(-1), `picloud-posix-${workspaces[0].volumeId}/workspace/original.txt`),
        );
        throw new Error("lost reply after partial-delete");
      }
      await rm(args.at(-1), { recursive: true });
      operation = "retired-delete";
    } else if (command === "xfs_info")
      stdout = `data     = bsize=4096 blocks=${(await lstat(paths.image)).size / 4096}\n`;
    else if (!["xfs_growfs", "sync"].includes(command))
      throw new Error(`Unexpected fixture command ${command}`);
    if (failAfter === operation) {
      failAfter = undefined;
      throw new Error(`lost reply after ${operation}`);
    }
    return { stdout, code };
  });
  const fetch = vi.fn(async (url, request) => {
    expect(helperAlive).toBe(true);
    expect(request.headers.Authorization).toBe("Bearer fixture-service-key");
    const path = new URL(url).pathname;
    if (path === "/v1/pool")
      return Response.json({ id: imageUUID, totalBytes: 63 * GiB, availableBytes: 62 * GiB });
    const input = JSON.parse(request.body),
      base = join(helperRoot, `picloud-posix-${input.volumeId}`);
    if (path === "/v1/quota/ensure") {
      let entry = projects.get(input.volumeId);
      if (!entry) {
        expect(await readdir(join(base, "workspace"))).toEqual([]);
        await mkdir(join(base, ".pi-cloud-runtime/uploads-v1/files"), { recursive: true });
        entry = {
          ...input,
          projectId: projects.size + 1001,
          version: 1,
          filesystemId: imageUUID,
          enforcedAt: 1000,
        };
        projects.set(input.volumeId, entry);
        await writeFile(join(base, ".pi-cloud-runtime/quota-enforced-v1"), JSON.stringify(entry));
      } else Object.assign(entry, input);
    }
    const entry = projects.get(input.volumeId);
    return Response.json({
      state: "ready",
      capacityBytes: entry.capacityBytes,
      revision: entry.revision,
      usedBytes: 0,
    });
  });
  const deps = {
    run,
    fetch,
    isRoot: () => true,
    chown: async () => {},
    readMountInfo: async () => "",
    statfs: async () => ({ bavail: 1024 ** 3, bsize: 4096 }),
    delay: async () => {},
    systemDirectory,
    verifierDirectory,
  };
  return {
    root,
    paths,
    options,
    deps,
    commands,
    run,
    fetch,
    state,
    projects,
    mounts,
    fault: (value) => {
      failAfter = value;
    },
    wrongUUID: () => {
      wrongUUID = true;
    },
    wrongProject: () => {
      wrongProject = true;
    },
    refuseStop: () => {
      refuseStop = true;
    },
    corruptCopy: () => {
      corruptData = true;
    },
  };
}

it("copies both original Workspaces/uploads only after project enforcement and removes the verified old directory", async () => {
  const f = await fixture();
  const result = await prepareWorkspaceStoragePool(f.options, f.deps);
  expect(result.state).toBe("complete");
  for (const [index, entry] of f.options.workspaces.entries()) {
    const base = join(f.paths.canonical, `picloud-posix-${entry.volumeId}`);
    expect(await readFile(join(base, "workspace/original.txt"), "utf8")).toBe(
      `original Workspace ${index}\n`,
    );
    expect(await readFile(join(base, ".pi-cloud-runtime/uploads-v1/files/partial"), "utf8")).toBe(
      `partial upload ${index}\n`,
    );
    expect(
      JSON.parse(await readFile(join(base, ".pi-cloud-runtime/quota-enforced-v1"))),
    ).toMatchObject({ generation: entry.generation, enforcedAt: 1000 });
  }
  expect(await exists((await f.state()).retired)).toBeUndefined();
  expect(
    f.commands
      .filter((c) => ["mount", "umount", "rsync", "mkfs.xfs", "truncate", "rm"].includes(c.command))
      .every((c) => Number.isInteger(c.lockFd)),
  ).toBe(true);
  const before = f.commands.filter((c) => c.command === "mkfs.xfs").length;
  await prepareWorkspaceStoragePool(f.options, f.deps);
  expect(f.commands.filter((c) => c.command === "mkfs.xfs")).toHaveLength(before);
});

it.each(["mkfs.xfs", "copy", "umount", "canonical-mount", "retired-delete", "partial-delete"])(
  "resumes a lost %s reply using the same owned image and original source identity",
  async (effect) => {
    const f = await fixture();
    f.fault(effect);
    await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow("lost reply");
    const interrupted = await f.state();
    const completed = await prepareWorkspaceStoragePool(f.options, f.deps);
    expect(completed.filesystemId).toBe(interrupted.filesystemId);
    expect(completed.state).toBe("complete");
    expect(f.commands.filter((c) => c.command === "mkfs.xfs")).toHaveLength(
      effect === "mkfs.xfs" ? 2 : 1,
    );
    expect(
      await readFile(
        join(
          f.paths.canonical,
          `picloud-posix-${f.options.workspaces[0].volumeId}/workspace/original.txt`,
        ),
        "utf8",
      ),
    ).toBe("original Workspace 0\n");
  },
);

it("prepares an explicitly empty first installation without a quota helper or PG callback", async () => {
  const f = await fixture(0);
  delete f.options.quotaHelper;
  delete f.options.assertQuiescent;
  f.options.fresh = true;
  expect((await prepareWorkspaceStoragePool(f.options, f.deps)).state).toBe("complete");
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.commands.some((c) => c.command === "systemd-run")).toBe(false);
});

it("reports PG growth requirements without formatting or changing existing files", async () => {
  const f = await fixture();
  f.options.workspaces[0].capacityBytes = 4096;
  const plan = await inspectWorkspaceStoragePool(f.options, f.deps);
  expect(plan.requiredWorkspaceGrowth).toMatchObject([
    { workspaceId: f.options.workspaces[0].workspaceId, minimumCapacityBytes: 2 * GiB },
  ]);
  expect(plan.ready).toBe(false);
  expect(await exists(f.paths.journal)).toBeUndefined();
  expect(f.commands.every((c) => ["findmnt", "du"].includes(c.command))).toBe(true);
});

it("preserves unrecognized Volume entries and refuses an unrelated backing file", async () => {
  const f = await fixture();
  await mkdir(join(f.paths.canonical, "unrecognized-volume"));
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow("Unrecognized");
  expect(await exists(join(f.paths.canonical, "unrecognized-volume"))).toBeDefined();
  await rm(join(f.paths.canonical, "unrecognized-volume"), { recursive: true });
  await writeFile(f.paths.image, "unowned data");
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow(
    "Unrecorded backing file",
  );
  expect(await readFile(f.paths.image, "utf8")).toBe("unowned data");
  expect(f.commands.some((c) => c.command === "mkfs.xfs")).toBe(false);
});

it("refuses a symlink Volume identity before formatting or copying", async () => {
  const f = await fixture();
  const identity = join(
    f.paths.canonical,
    `picloud-posix-${f.options.workspaces[0].volumeId}/.pi-cloud-runtime/identity`,
  );
  await rename(identity, `${identity}.original`);
  await symlink(`${identity}.original`, identity);
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow();
  expect(f.commands.some((c) => c.command === "mkfs.xfs")).toBe(false);
  expect(await exists(`${identity}.original`)).toBeDefined();
});

it("keeps the original tree after checksum mismatch and repairs only the staged copy on resume", async () => {
  const f = await fixture();
  f.corruptCopy();
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow(
    "checksum/metadata verification differs",
  );
  expect(
    await readFile(
      join(
        f.paths.canonical,
        `picloud-posix-${f.options.workspaces[0].volumeId}/workspace/original.txt`,
      ),
      "utf8",
    ),
  ).toBe("original Workspace 0\n");
  expect(await exists((await f.state()).retired)).toBeUndefined();
  expect((await prepareWorkspaceStoragePool(f.options, f.deps)).state).toBe("complete");
  expect(f.commands.filter((c) => c.command === "mkfs.xfs")).toHaveLength(1);
});

it("cannot move the source while its temporary helper is still running", async () => {
  const f = await fixture();
  f.refuseStop();
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow(
    "positively stopped",
  );
  expect(await exists(f.paths.canonical)).toBeDefined();
  expect(await exists((await f.state()).retired)).toBeUndefined();
  expect(f.commands.some((c) => c.command === "umount")).toBe(false);
});

it("refuses mismatched upload/Workspace project IDs before copying any original bytes", async () => {
  const f = await fixture();
  f.wrongProject();
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow(
    "share the enforced project",
  );
  expect(f.commands.some((c) => c.command === "rsync" && !c.args.includes("--dry-run"))).toBe(
    false,
  );
  expect(await exists(f.paths.canonical)).toBeDefined();
});

it("never deletes the retired source after a wrong UUID appears at the canonical mount", async () => {
  const f = await fixture();
  f.fault("canonical-mount");
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow("lost reply");
  f.wrongUUID();
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow(
    "Expected quota-enabled XFS UUID",
  );
  expect(await exists((await f.state()).retired)).toBeDefined();
  expect(f.commands.some((c) => c.command === "rm")).toBe(false);
});

it("persists growth before extending the file, resumes lost loop-capacity replies and never shrinks", async () => {
  const f = await fixture();
  await prepareWorkspaceStoragePool(f.options, f.deps);
  f.fault("set-capacity");
  const growth = { runtimeDirectory: f.options.runtimeDirectory, poolBytes: 128 * GiB };
  await expect(growWorkspaceStoragePool(growth, f.deps)).rejects.toThrow("lost reply");
  expect((await f.state()).growthTargetBytes).toBe(128 * GiB);
  await expect(
    growWorkspaceStoragePool({ ...growth, poolBytes: 64 * GiB }, f.deps),
  ).rejects.toThrow("cannot shrink");
  expect((await growWorkspaceStoragePool(growth, f.deps)).poolBytes).toBe(128 * GiB);
  expect((await f.state()).growthTargetBytes).toBeUndefined();
  await rm(f.paths.image);
  await expect(verifyWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow();
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow();
  expect(await exists(f.paths.image)).toBeUndefined();
});

it("requires the persistent UUID mount before K3s and keeps the backing image outside the Volume tree", () => {
  const paths = workspacePoolPaths("/srv/pi-cloud/runtime");
  const files = workspacePoolSystemdFiles(
    paths,
    { id: randomUUID(), filesystemId: randomUUID() },
    "srv-pi\\x2dcloud-runtime-state-cube\\x2dshared-volume.mount",
  );
  expect(files.mountBody).toContain("Options=loop,prjquota,nosuid,nodev");
  expect(files.dropInBody).toMatch(/Requires=.*\.mount\nAfter=.*\.mount/);
  expect(files.verifyBody).toContain("-o UUID");
  expect(files.verifyBody).toContain("exit 1");
  expect(paths.image.startsWith(paths.canonical + "/")).toBe(false);
});

it.each(["api", "master", "cube-node", "workspace-quota", "session-runtime", "trusted-pi-worker"])(
  "a remaining %s Pod prevents the filesystem handoff even when terminating",
  (component) => {
    const workload = {
      kind: "Deployment",
      metadata: { labels: { "app.kubernetes.io/component": "control-plane" } },
      spec: { replicas: 0 },
    };
    const pod = {
      kind: "Pod",
      metadata: { deletionTimestamp: "now", labels: { "app.kubernetes.io/component": component } },
    };
    expect(() =>
      assertWorkspaceStorageProcessesStopped([workload, pod], "/srv/runtime/volume"),
    ).toThrow("have not physically exited");
  },
);

it("does not infer physical VM retirement from an empty Kubernetes inventory or a stale proof", async () => {
  const f = await fixture();
  f.options.assertQuiescent.mockResolvedValue({
    runtimeQuiescent: true,
    physicalVMsAbsent: false,
    schemaVersion: 212,
  });
  await expect(prepareWorkspaceStoragePool(f.options, f.deps)).rejects.toThrow("physical absence");
  expect(f.commands.some((c) => c.command === "mkfs.xfs")).toBe(false);
  expect(() => assertWorkspaceStorageProcessesStopped([], f.paths.canonical)).toThrow(
    "inventory is missing",
  );
  expect(() =>
    assertWorkspaceStorageProcessesStopped(
      [
        {
          kind: "Deployment",
          metadata: { labels: { "app.kubernetes.io/component": "control-plane" } },
          spec: { replicas: 0 },
        },
      ],
      f.paths.canonical,
      true,
    ),
  ).toThrow("cannot bypass");
});
