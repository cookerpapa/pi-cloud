import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPrivateRuntimeFile } from "./runtime-file-policy.mjs";

const GiB = 1024 ** 3;
const MAX_STATE_BYTES = 16 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATION = /^[0-9a-f]{64}$/;
const VOLUME = /^picloud-posix-pcw-[0-9a-f]{48}$/;
const PHASES = [
  "preparing",
  "formatted",
  "copying",
  "verified",
  "cutover",
  "mounted",
  "retiring",
  "complete",
];
export const DEFAULT_WORKSPACE_POOL_BYTES = 256 * GiB;

function pathValue(value) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(value) || resolve(value) !== value)
    throw new Error(
      "Storage pool paths must be normalized absolute paths without shell/systemd metacharacters",
    );
  return value;
}
function bytes(value, label, minimum = 4096) {
  if (!Number.isSafeInteger(value) || value < minimum || value % 4096 !== 0)
    throw new Error(`${label} must be a positive, 4096-byte-aligned safe integer`);
  return value;
}
const fingerprint = (metadata) => {
  if (!Number.isSafeInteger(metadata.dev) || !Number.isSafeInteger(metadata.ino))
    throw new Error("Filesystem inode identity exceeds the supported integer range");
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
};
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const aligned = (value) => Math.ceil(value / GiB) * GiB;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function workspacePoolPaths(runtimeDirectory) {
  const runtime = pathValue(runtimeDirectory);
  const control = join(runtime, "state/workspace-storage-pool");
  return {
    runtime,
    control,
    journal: join(control, "state.json"),
    lock: join(control, "operator.lock"),
    image: join(control, "pool.xfs"),
    staging: join(control, "staging"),
    canonical: join(runtime, "state/cube-shared/volume"),
  };
}
export function normalizeWorkspacePoolPlan(workspaces = []) {
  if (!Array.isArray(workspaces) || workspaces.length > 20_000)
    throw new Error("Workspace migration inventory is invalid or too large");
  const seen = new Set();
  return workspaces
    .map((workspace) => {
      const { tenantId, workspaceId, generation = null, revision, capacityBytes } = workspace;
      if (
        !UUID.test(tenantId) ||
        !UUID.test(workspaceId) ||
        (generation !== null && !GENERATION.test(generation))
      )
        throw new Error("Workspace migration identity is invalid");
      const volumeId = `pcw-${hash(`pi-cloud.workspace-volume.v1\0${tenantId}\0${workspaceId}`).slice(0, 48)}`;
      if (
        (workspace.volumeId !== undefined && workspace.volumeId !== volumeId) ||
        seen.has(volumeId)
      )
        throw new Error("Workspace migration inventory has a duplicate or mismatched Volume");
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new Error("Workspace quota revision is invalid");
      seen.add(volumeId);
      return {
        tenantId,
        workspaceId,
        volumeId,
        generation,
        revision,
        capacityBytes: bytes(capacityBytes, "Workspace capacity"),
      };
    })
    .sort((a, b) => a.volumeId.localeCompare(b.volumeId));
}

/** All mutation subprocesses inherit fd 3, the SAME flock open-file description.
 * A dead Node parent cannot unlock a still-running rsync or formatter. */
export async function storagePoolCommand(
  command,
  args,
  { lockFd, timeoutMs = 60_000, allowedExitCodes = [0] } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe", ...(lockFd === undefined ? [] : [lockFd])],
    });
    let output = "",
      size = 0,
      failure;
    let force;
    const stop = (message) => {
      failure ??= new Error(message);
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(
      () => stop(`${command} exceeded its bounded operation time`),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 ** 2) stop(`${command} exceeded its bounded output`);
      else output += chunk.toString("utf8");
    });
    // Do not echo user filenames, file contents or credential diagnostics.
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(force);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (failure || !allowedExitCodes.includes(code))
        rejectPromise(failure ?? new Error(`${command} failed (exit ${code})`));
      else resolvePromise({ stdout: output, code });
    });
  });
}
async function metadata(path, optional = false) {
  try {
    return await lstat(path);
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function safeParents(path, allowMissing = false) {
  let current = "/";
  for (const part of pathValue(path).split("/").slice(1)) {
    current = join(current, part);
    const value = await metadata(current, allowMissing);
    if (!value && allowMissing) return;
    if (!value.isDirectory() || value.isSymbolicLink())
      throw new Error("Storage pool parent is not an ordinary directory");
  }
}
async function syncDirectory(path) {
  const fd = await open(path, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function atomicFile(path, body, mode = 0o600) {
  const temporary = `${path}.new-${randomUUID()}`;
  const fd = await open(temporary, "wx", mode);
  try {
    try {
      await fd.writeFile(body);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
async function readState(paths) {
  if (!(await metadata(paths.journal, true))) return undefined;
  const value = JSON.parse(
    await readPrivateRuntimeFile(paths.journal, MAX_STATE_BYTES, "Workspace storage journal"),
  );
  if (
    value.version !== 1 ||
    !UUID.test(value.id) ||
    !UUID.test(value.filesystemId) ||
    !PHASES.includes(value.phase) ||
    typeof value.fresh !== "boolean" ||
    (value.fresh && value.workspaces?.length) ||
    JSON.stringify(value.paths) !== JSON.stringify(paths) ||
    value.retired !== `${paths.canonical}.pre-xfs-${value.id}` ||
    value.helperUnit !== `pi-cloud-workspace-migration-${value.id}.service`
  )
    throw new Error("Workspace storage journal identity changed");
  normalizeWorkspacePoolPlan(value.workspaces);
  for (const identity of [
    value.sourceIdentity,
    ...(value.imageIdentity ? [value.imageIdentity] : []),
  ])
    if (!identity || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino))
      throw new Error("Journal inode identity is invalid");
  if (value.phase !== "preparing" && !value.imageIdentity)
    throw new Error("Formatted pool has no recorded backing-file identity");
  if (value.workspaces.length) helperConfiguration(value.helper);
  bytes(value.poolBytes, "Recorded pool size", 512 * 1024 ** 2);
  if (
    value.imageTemporary !== undefined &&
    (!value.imageTemporary.startsWith(`${paths.image}.new-`) ||
      !UUID.test(value.imageTemporary.slice(`${paths.image}.new-`.length)))
  )
    throw new Error("Initial image temporary path changed");
  if (value.growthTargetBytes !== undefined)
    bytes(value.growthTargetBytes, "Recorded growth target", value.poolBytes);
  return value;
}
async function saveState(paths, value) {
  const body = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(body) > MAX_STATE_BYTES)
    throw new Error("Workspace migration journal exceeds its bound");
  await atomicFile(paths.journal, body);
}
async function noNestedMounts(root, deps) {
  const body = await (deps.readMountInfo ?? (() => readFile("/proc/self/mountinfo", "utf8")))();
  for (const line of body.trim().split("\n")) {
    const target = line
      .split(" ")[4]
      ?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (target?.startsWith(root + "/"))
      throw new Error("A nested mount prevents a complete Workspace copy");
  }
}
async function mounted(target, run) {
  const result = await run(
    "findmnt",
    ["--json", "--mountpoint", target, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,UUID"],
    { allowedExitCodes: [0, 1] },
  );
  if (result.code === 1) return undefined;
  const rows = JSON.parse(result.stdout).filesystems;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].target !== target)
    throw new Error("Mount identity is ambiguous");
  return rows[0];
}
async function usage(path, run) {
  if (!(await metadata(path, true))) return 0;
  const result = await run("du", ["--summarize", "--block-size=1", "--", path]);
  const value = Number(result.stdout.match(/^(\d+)\s/)?.[1]);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Workspace usage could not be measured");
  return value;
}
async function inventory(root, plan, run, deps) {
  await safeParents(root);
  if (await mounted(root, run)) throw new Error("Unowned mounted Volume storage cannot be adopted");
  await noNestedMounts(root, deps);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 20_000)
    throw new Error("Workspace migration inventory exceeds its bounded scan");
  const indexed = new Map(plan.map((entry) => [`picloud-posix-${entry.volumeId}`, entry]));
  const result = [];
  for (const entry of entries) {
    const item = indexed.get(entry.name);
    if (!entry.isDirectory() || !VOLUME.test(entry.name) || !item || !item.generation)
      throw new Error(
        "Unrecognized Volume storage entry; complete its PG identity before migrating",
      );
    const path = join(root, entry.name),
      meta = join(path, ".pi-cloud-runtime");
    await safeParents(meta);
    await safeParents(join(path, "workspace"));
    const fd = await open(
      join(meta, "identity"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await fd.stat();
      if (
        !info.isFile() ||
        info.size > 1024 ||
        (await fd.readFile("utf8")) !== `pi-cloud-volume-v1\n${item.volumeId}\n${item.generation}\n`
      )
        throw new Error("Workspace Volume identity differs from the PG inventory");
    } finally {
      await fd.close();
    }
    for (const name of ["delete-authorized", "quota-enforced-v1"])
      if (await metadata(join(meta, name), true))
        throw new Error("Closing or already enforced Volume requires explicit reconciliation");
    for (const name of ["gateway.lock", "quota.lock"]) {
      const lock = await metadata(join(meta, name), true);
      if (lock && (!lock.isFile() || lock.isSymbolicLink()))
        throw new Error("Volume lock metadata is not a regular file");
    }
    if (await metadata(join(meta, "uploads-v1"), true)) await safeParents(join(meta, "uploads-v1"));
    const uploads = join(meta, "uploads-v1/files");
    if (await metadata(uploads, true)) await safeParents(uploads);
    const usedBytes = (await usage(join(path, "workspace"), run)) + (await usage(uploads, run));
    result.push({ ...item, source: fingerprint(await lstat(path)), usedBytes });
  }
  return result.sort((a, b) => a.volumeId.localeCompare(b.volumeId));
}

export async function inspectWorkspaceStoragePool(options, deps = {}) {
  const paths = workspacePoolPaths(options.runtimeDirectory);
  const plan = normalizeWorkspacePoolPlan(options.workspaces);
  const run = deps.run ?? storagePoolCommand;
  const state = await readState(paths);
  if (state)
    return {
      state: state.phase,
      filesystemId: state.filesystemId,
      poolBytes: state.poolBytes,
      resume: state.phase !== "complete",
      paths,
    };
  await safeParents(paths.runtime);
  const source = await metadata(paths.canonical, true);
  if (!source && !options.fresh)
    throw new Error("Existing Volume directory is missing; refusing empty replacement");
  const volumes = source ? await inventory(paths.canonical, plan, run, deps) : [];
  if (options.fresh && (volumes.length || plan.length))
    throw new Error("Fresh installation requires an empty Volume directory and inventory");
  const margin = bytes(options.minimumHeadroomBytes ?? GiB, "Workspace headroom");
  const growth = volumes.flatMap((entry) => {
    const required = aligned(entry.usedBytes + Math.max(margin, Math.ceil(entry.usedBytes / 4)));
    return required > entry.capacityBytes
      ? [
          {
            tenantId: entry.tenantId,
            workspaceId: entry.workspaceId,
            volumeId: entry.volumeId,
            previousRevision: entry.revision,
            minimumCapacityBytes: required,
          },
        ]
      : [];
  });
  const sourceBytes = source ? await usage(paths.canonical, run) : 0;
  const minimumPoolBytes = aligned(
    Math.max(sourceBytes * 1.25 + GiB, ...volumes.map((v) => v.capacityBytes + GiB)),
  );
  const poolBytes = bytes(
    options.poolBytes ?? DEFAULT_WORKSPACE_POOL_BYTES,
    "Pool size",
    512 * 1024 ** 2,
  );
  const host = await (deps.statfs ?? statfs)(paths.runtime);
  const availableHostBytes = Number(host.bavail) * Number(host.bsize);
  return {
    state: "absent",
    paths,
    volumes,
    requiredWorkspaceGrowth: growth,
    poolBytes,
    minimumPoolBytes,
    sourceBytes,
    availableHostBytes,
    requiredHostBytes: sourceBytes + GiB,
    ready:
      growth.length === 0 &&
      poolBytes >= minimumPoolBytes &&
      availableHostBytes >= sourceBytes + GiB,
  };
}

async function withLock(options, deps, work) {
  if (!(deps.isRoot ?? (() => process.geteuid?.() === 0))())
    throw new Error("Workspace pool mutation requires the root operator");
  const paths = workspacePoolPaths(options.runtimeDirectory);
  await safeParents(paths.runtime);
  await safeParents(dirname(paths.control), true);
  await mkdir(paths.control, { recursive: true, mode: 0o700 });
  await safeParents(paths.control);
  const control = await lstat(paths.control);
  if (control.mode & 0o077) throw new Error("Workspace pool control directory must be private");
  const fd = await open(
    paths.lock,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const rawRun = deps.run ?? storagePoolCommand;
  const run = (command, args, extra = {}) => rawRun(command, args, { ...extra, lockFd: fd.fd });
  try {
    await run("flock", ["--exclusive", "--nonblock", "3"]);
    return await work(paths, run);
  } finally {
    await fd.close();
  }
}
function helperConfiguration(value) {
  if (
    !value ||
    !/^127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(value.listen ?? "") ||
    Number(value.listen.split(":")[1]) > 65535
  )
    throw new Error("Migration helper requires an explicit loopback listener");
  const url = new URL(value.meteringUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Metering receiver URL is invalid");
  return {
    binary: pathValue(value.binary),
    tokenFile: pathValue(value.tokenFile),
    meteringTokenFile: pathValue(value.meteringTokenFile),
    meteringUrl: url.href,
    listen: value.listen,
  };
}
async function gate(options, state) {
  if (state.fresh) return;
  const proof = await options.assertQuiescent?.();
  if (
    !proof ||
    proof.runtimeQuiescent !== true ||
    proof.physicalVMsAbsent !== true ||
    !Number.isSafeInteger(proof.schemaVersion) ||
    proof.schemaVersion < 212
  )
    throw new Error(
      "Fresh release proof of runtime quiescence, all-VM physical absence and schema 212 is required",
    );
}
async function systemdState(unit, run) {
  const result = await run(
    "systemctl",
    ["show", unit, "--property=LoadState,ActiveState,MainPID,ControlPID"],
    { allowedExitCodes: [0, 1, 4] },
  );
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}
async function stopHelper(state, run) {
  const before = await systemdState(state.helperUnit, run);
  if (before.LoadState === "not-found") return;
  await run("systemctl", ["stop", state.helperUnit], { timeoutMs: 45_000 });
  const after = await systemdState(state.helperUnit, run);
  if (
    after.LoadState !== "not-found" &&
    (!["inactive", "failed"].includes(after.ActiveState) ||
      after.MainPID !== "0" ||
      after.ControlPID !== "0")
  )
    throw new Error("Temporary quota helper has not positively stopped");
}
async function imageIdentity(paths, state) {
  const actual = await lstat(paths.image);
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    !same(fingerprint(actual), state.imageIdentity) ||
    actual.nlink !== 1
  )
    throw new Error("Workspace pool backing-file identity changed");
  if (state.phase !== "preparing" && actual.size < state.poolBytes)
    throw new Error("Workspace pool backing file was truncated");
  return actual;
}
async function verifyMount(paths, state, target, run, deps) {
  await imageIdentity(paths, state);
  const mount = await mounted(target, run);
  const flags = new Set(mount?.options?.split(",") ?? []);
  if (
    !mount ||
    mount.fstype !== "xfs" ||
    mount.uuid !== state.filesystemId ||
    !(flags.has("prjquota") || flags.has("pquota")) ||
    !flags.has("nosuid") ||
    !flags.has("nodev") ||
    !flags.has("rw")
  )
    throw new Error("Expected quota-enabled XFS UUID is not mounted at the owned path");
  const loops = JSON.parse(
    (
      await run("losetup", [
        "--json",
        "--list",
        "--associated",
        paths.image,
        "--output",
        "NAME,BACK-FILE",
      ])
    ).stdout,
  ).loopdevices;
  if (
    !Array.isArray(loops) ||
    loops.length !== 1 ||
    loops[0].name !== mount.source ||
    loops[0]["back-file"] !== paths.image
  )
    throw new Error("Workspace mount has an unexpected or duplicate loop backing");
  await noNestedMounts(target, deps);
  return mount;
}
async function ownedDirectory(path) {
  const existing = await metadata(path, true);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error("Workspace migration path is not a directory");
  if (!existing) await mkdir(path, { mode: 0o750 });
}
async function emptyMountpoint(path) {
  await ownedDirectory(path);
  if ((await readdir(path)).length) throw new Error("Refusing to mount over nonempty local files");
}

export function workspacePoolSystemdFiles(paths, state, mountUnit) {
  const key = hash(paths.canonical).slice(0, 16);
  const verifier = `/usr/local/libexec/pi-cloud-workspace-pool-${key}`;
  const tag = `# PiCloud workspace-storage-pool ${state.id}\n`;
  return {
    verifier,
    dropIn: `k3s.service.d/pi-cloud-workspace-pool-${key}.conf`,
    verifyBody: `#!/bin/sh\n${tag}set -eu\n[ "$(findmnt -rn -M '${paths.canonical}' -o UUID)" = '${state.filesystemId}' ]\n[ "$(findmnt -rn -M '${paths.canonical}' -o FSTYPE)" = xfs ]\noptions=",$(findmnt -rn -M '${paths.canonical}' -o OPTIONS),"\ncase "$options" in *,prjquota,*|*,pquota,*) ;; *) exit 1;; esac\ncase "$options" in *,nosuid,*) ;; *) exit 1;; esac\ncase "$options" in *,nodev,*) ;; *) exit 1;; esac\n`,
    dropInBody: `${tag}[Unit]\nRequires=${mountUnit}\nAfter=${mountUnit}\n[Service]\nExecStartPre=${verifier}\n`,
    mountBody: `${tag}[Unit]\nDescription=PiCloud persistent Workspace XFS pool\nBefore=k3s.service\nRequiresMountsFor=${dirname(paths.image)}\n[Mount]\nWhat=${paths.image}\nWhere=${paths.canonical}\nType=xfs\nOptions=loop,prjquota,nosuid,nodev\nTimeoutSec=60\n[Install]\nWantedBy=local-fs.target\n`,
  };
}
async function installOwnedFile(path, body, id, mode) {
  await safeParents(dirname(path), true);
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const existing = await metadata(path, true);
  if (
    existing &&
    (!existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size > 64 * 1024 ||
      !(await readFile(path, "utf8")).includes(`# PiCloud workspace-storage-pool ${id}\n`))
  )
    throw new Error("Refusing to replace an unowned systemd file");
  await atomicFile(path, body, mode);
  await chmod(path, mode);
}
async function installSystemd(paths, state, run, deps, mount) {
  const unit = (
    await run("systemd-escape", ["--path", "--suffix=mount", paths.canonical])
  ).stdout.trim();
  if (!/^[A-Za-z0-9_.\\-]+\.mount$/.test(unit)) throw new Error("Invalid systemd mount unit name");
  const files = workspacePoolSystemdFiles(paths, state, unit);
  const system = deps.systemDirectory ?? "/etc/systemd/system";
  const verifier = deps.verifierDirectory
    ? join(deps.verifierDirectory, files.verifier.split("/").at(-1))
    : files.verifier;
  await installOwnedFile(verifier, files.verifyBody, state.id, 0o755);
  await installOwnedFile(
    join(system, files.dropIn),
    files.dropInBody.replace(files.verifier, verifier),
    state.id,
    0o644,
  );
  if (mount) await installOwnedFile(join(system, unit), files.mountBody, state.id, 0o644);
  else if (
    (await metadata(join(system, unit), true)) ||
    (await systemdState(unit, run)).LoadState !== "not-found"
  )
    throw new Error("Mount unit exists before verified directory handoff");
  await run("systemctl", ["daemon-reload"]);
  if (mount) {
    await run("systemctl", ["enable", unit]);
    await run("systemctl", ["start", unit]);
  }
}
async function quotaSession(paths, state, target, run, deps, work) {
  if (!state.workspaces.length) return;
  const helper = state.helper;
  const token = (
    await readPrivateRuntimeFile(helper.tokenFile, 64 * 1024, "Workspace helper credential")
  ).trim();
  if (!token) throw new Error("Workspace helper credential is empty");
  await stopHelper(state, run);
  const env = {
    PI_CLOUD_WORKSPACE_POSIX_ROOT: target,
    PI_CLOUD_WORKSPACE_QUOTA_LISTEN: helper.listen,
    PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: helper.tokenFile,
    PI_CLOUD_METERING_TOKEN_FILE: helper.meteringTokenFile,
    PI_CLOUD_RESOURCE_METERING_URL: helper.meteringUrl,
    PI_CLOUD_RESOURCE_METERING_SOURCE_ID: state.sourceId,
  };
  const request = async (path, body, timeoutMs = 35_000) => {
    const response = await (deps.fetch ?? fetch)(`http://${helper.listen}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Workspace quota helper rejected ${path} (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024) throw new Error("Workspace quota response exceeded its bound");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  try {
    await run("systemd-run", [
      "--unit",
      state.helperUnit,
      "--collect",
      "--service-type=exec",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=30s",
      "--property=SendSIGKILL=yes",
      "--property=RuntimeMaxSec=21600",
      ...Object.entries(env).map(([name, value]) => `--setenv=${name}=${value}`),
      "--",
      helper.binary,
    ]);
    let ready = false;
    for (let n = 0; n < 40; n++) {
      try {
        const pool = await request("/v1/pool", undefined, 1000);
        if (pool.id !== state.filesystemId) throw new Error("Quota helper filesystem UUID changed");
        ready = true;
        break;
      } catch (error) {
        if (String(error.message).includes("UUID changed")) throw error;
      }
      await (deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(250);
    }
    if (!ready) throw new Error("Temporary quota helper did not become ready");
    await work(request);
  } finally {
    await stopHelper(state, run);
  }
}
async function quotaRoots(root, entry, run, filesystemId) {
  const base = join(root, `picloud-posix-${entry.volumeId}`);
  const marker = JSON.parse(
    await readFile(join(base, ".pi-cloud-runtime/quota-enforced-v1"), "utf8"),
  );
  if (
    marker.tenantId !== entry.tenantId ||
    marker.workspaceId !== entry.workspaceId ||
    marker.volumeId !== entry.volumeId ||
    marker.generation !== entry.generation ||
    marker.filesystemId !== filesystemId ||
    marker.version !== 1 ||
    !Number.isSafeInteger(marker.enforcedAt) ||
    marker.enforcedAt <= 0 ||
    !Number.isSafeInteger(marker.projectId) ||
    marker.projectId <= 0
  )
    throw new Error("Quota generation marker changed");
  for (const suffix of ["workspace", ".pi-cloud-runtime/uploads-v1/files"]) {
    const info = (await run("xfs_io", ["-r", "-c", "stat", join(base, suffix)])).stdout;
    if (
      Number(info.match(/fsxattr\.projid\s*=\s*(\d+)/)?.[1]) !== marker.projectId ||
      !info.includes("proj-inherit")
    )
      throw new Error("Workspace and upload files do not share the enforced project");
  }
}
const quotaRequest = ({
  tenantId,
  workspaceId,
  volumeId,
  generation,
  revision,
  capacityBytes,
}) => ({ tenantId, workspaceId, volumeId, generation, revision, capacityBytes });
async function copyAndVerify(source, destination, run, copy = true) {
  // Only the owned destination is reconciled. Preserve the helper's new state,
  // but remove incomplete rsync temporaries left by a killed copying process.
  const args = [
    "-aHAXS",
    "--numeric-ids",
    "--one-file-system",
    "--delete-delay",
    "--filter=P /.pi-cloud-quota/***",
    ...["quota-enforced-v1", "gateway.lock", "quota.lock", "uploads-v1/", "uploads-v1/files/"].map(
      (path) => `--filter=P /picloud-posix-*/.pi-cloud-runtime/${path}`,
    ),
  ];
  if (copy) {
    await run("rsync", [...args, "--", `${source}/`, `${destination}/`], {
      timeoutMs: 6 * 60 * 60_000,
    });
    await run("sync", ["--file-system", destination], { timeoutMs: 120_000 });
  }
  const checked = await run(
    "rsync",
    [
      ...args,
      "--checksum",
      "--dry-run",
      "--itemize-changes",
      "--out-format=%i %n%L",
      "--",
      `${source}/`,
      `${destination}/`,
    ],
    { timeoutMs: 6 * 60 * 60_000 },
  );
  if (checked.stdout.trim())
    throw new Error(
      "Workspace checksum/metadata verification differs; original bytes are retained",
    );
}

export async function prepareWorkspaceStoragePool(options, deps = {}) {
  return withLock(options, deps, async (paths, run) => {
    let state = await readState(paths);
    if (state?.phase === "complete") return verifyWorkspaceStoragePool(options, { ...deps, run });
    if (!state) {
      const plan = await inspectWorkspaceStoragePool(options, { ...deps, run });
      if (!plan.ready)
        throw Object.assign(
          new Error("Workspace migration needs PG capacity growth or additional pool/host space"),
          { plan },
        );
      const id = randomUUID();
      state = {
        version: 1,
        id,
        filesystemId: randomUUID(),
        paths,
        phase: "preparing",
        fresh: options.fresh === true,
        sourceId: options.sourceId ?? "",
        sourceIdentity: undefined,
        poolBytes: plan.poolBytes,
        workspaces: plan.volumes,
        helper: plan.volumes.length ? helperConfiguration(options.quotaHelper) : null,
        retired: `${paths.canonical}.pre-xfs-${id}`,
        helperUnit: `pi-cloud-workspace-migration-${id}.service`,
      };
      if (state.workspaces.length && !/^workspace:[A-Za-z0-9.-]+$/.test(state.sourceId))
        throw new Error("Stable Workspace metering source ID is required");
      await gate(options, state);
      if (!(await metadata(paths.canonical, true))) {
        await mkdir(dirname(paths.canonical), { recursive: true, mode: 0o750 });
        await mkdir(paths.canonical, { mode: 0o750 });
      }
      state.sourceIdentity = fingerprint(await lstat(paths.canonical));
      await saveState(paths, state);
    }
    await gate(options, state);
    if (!state.fresh) {
      if (options.sourceId !== state.sourceId)
        throw new Error("Migration metering source identity changed");
      const current = new Map(
        normalizeWorkspacePoolPlan(options.workspaces).map((entry) => [entry.volumeId, entry]),
      );
      let changed = false;
      state.workspaces = state.workspaces.map((entry) => {
        const next = current.get(entry.volumeId);
        if (
          !next ||
          next.tenantId !== entry.tenantId ||
          next.workspaceId !== entry.workspaceId ||
          next.generation !== entry.generation ||
          next.revision < entry.revision ||
          next.capacityBytes < entry.capacityBytes ||
          (next.revision === entry.revision && next.capacityBytes !== entry.capacityBytes)
        )
          throw new Error("Persisted migration Workspace plan changed or shrank");
        if (next.revision !== entry.revision) changed = true;
        return { ...entry, ...next };
      });
      if (changed) {
        if (PHASES.indexOf(state.phase) >= PHASES.indexOf("cutover"))
          throw new Error(
            "Finish the current filesystem handoff before changing its PG capacity plan",
          );
        await saveState(paths, state);
      }
    }
    await stopHelper(state, run);
    const setPhase = async (phase) => {
      state.phase = phase;
      await saveState(paths, state);
    };
    if (PHASES.indexOf(state.phase) < PHASES.indexOf("cutover"))
      await installSystemd(paths, state, run, deps, false);
    if (state.phase === "preparing") {
      if (!state.imageIdentity) {
        if (await metadata(paths.image, true))
          throw new Error("Unrecorded backing file exists; refusing to format it");
        const temporary = `${paths.image}.new-${randomUUID()}`;
        const fd = await open(temporary, "wx", 0o600);
        try {
          await fd.writeFile(`PiCloud Workspace pool ${state.id}\n`);
          await fd.sync();
          state.imageIdentity = fingerprint(await fd.stat());
        } finally {
          await fd.close();
        }
        state.imageTemporary = temporary;
        await saveState(paths, state);
      }
      if (state.imageTemporary) {
        const temporary = await metadata(state.imageTemporary, true);
        const installed = await metadata(paths.image, true);
        if (!installed) {
          if (!temporary?.isFile() || !same(fingerprint(temporary), state.imageIdentity))
            throw new Error("Owned initial pool image is missing");
          await link(state.imageTemporary, paths.image);
          await syncDirectory(paths.control);
        } else if (!same(fingerprint(installed), state.imageIdentity))
          throw new Error("Backing file was replaced before formatting");
        if (temporary) {
          if (!same(fingerprint(temporary), state.imageIdentity))
            throw new Error("Initial image link changed");
          await unlink(state.imageTemporary);
        }
        delete state.imageTemporary;
        await saveState(paths, state);
      }
      const initialImage = await imageIdentity(paths, state);
      if (initialImage.size > state.poolBytes)
        throw new Error("Initial pool backing file cannot shrink");
      if ((await mounted(paths.canonical, run)) || (await mounted(paths.staging, run)))
        throw new Error("Refusing to format a mounted pool");
      const loops = JSON.parse(
        (
          await run("losetup", [
            "--json",
            "--list",
            "--associated",
            paths.image,
            "--output",
            "NAME,BACK-FILE",
          ])
        ).stdout,
      ).loopdevices;
      if (!Array.isArray(loops) || loops.length)
        throw new Error("Refusing to format an image attached to any loop device");
      const signature = await run("blkid", ["-p", "-o", "export", paths.image], {
        allowedExitCodes: [0, 2],
      });
      if (
        signature.code === 0 &&
        (!signature.stdout.includes(`UUID=${state.filesystemId}\n`) ||
          !signature.stdout.includes("TYPE=xfs\n"))
      )
        throw new Error("Backing file contains an unknown filesystem");
      await run("truncate", ["--size", String(state.poolBytes), "--", paths.image]);
      await run("mkfs.xfs", ["-f", "-m", `uuid=${state.filesystemId}`, paths.image], {
        timeoutMs: 120_000,
      });
      await setPhase("formatted");
    }
    if (["formatted", "copying", "verified"].includes(state.phase)) {
      if (!same(fingerprint(await lstat(paths.canonical)), state.sourceIdentity))
        throw new Error("Original Volume directory identity changed");
      const current = await inventory(paths.canonical, state.workspaces, run, deps);
      if (
        current.length !== state.workspaces.length ||
        current.some((entry, index) => !same(entry.source, state.workspaces[index].source))
      )
        throw new Error("A source Volume directory changed after migration planning");
      if (!(await mounted(paths.staging, run))) {
        await emptyMountpoint(paths.staging);
        await run("mount", [
          "-t",
          "xfs",
          "-o",
          "loop,prjquota,nosuid,nodev",
          paths.image,
          paths.staging,
        ]);
      }
      await verifyMount(paths, state, paths.staging, run, deps);
      await setPhase("copying");
      for (const entry of state.workspaces) {
        const name = `picloud-posix-${entry.volumeId}`,
          base = join(paths.staging, name),
          meta = join(base, ".pi-cloud-runtime");
        await ownedDirectory(base);
        await ownedDirectory(meta);
        await ownedDirectory(join(base, "workspace"));
        for (const path of [base, meta, join(base, "workspace")])
          await (deps.chown ?? chown)(path, 1000, 1000);
        const target = join(meta, "identity");
        if (!(await metadata(target, true)))
          await copyFile(
            join(paths.canonical, name, ".pi-cloud-runtime/identity"),
            target,
            constants.COPYFILE_EXCL,
          );
        await (deps.chown ?? chown)(target, 1000, 1000);
        // The root helper must not create a mode-0600 admission lock that the
        // ordinary UID-1000 Volume Gateway cannot subsequently open.
        for (const lock of [join(meta, "gateway.lock"), join(meta, "quota.lock")]) {
          const fd = await open(
            lock,
            constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );
          await fd.close();
          await (deps.chown ?? chown)(lock, 1000, 1000);
        }
      }
      await quotaSession(paths, state, paths.staging, run, deps, async (request) => {
        for (const entry of state.workspaces) {
          const quota = await request("/v1/quota/ensure", quotaRequest(entry));
          if (
            quota.state !== "ready" ||
            quota.capacityBytes !== entry.capacityBytes ||
            quota.revision !== entry.revision
          )
            throw new Error("Workspace quota was not confirmed before copy");
          await quotaRoots(paths.staging, entry, run, state.filesystemId);
        }
        await gate(options, state);
        await copyAndVerify(paths.canonical, paths.staging, run);
        for (const entry of state.workspaces)
          await quotaRoots(paths.staging, entry, run, state.filesystemId);
      });
      if (!state.workspaces.length) await copyAndVerify(paths.canonical, paths.staging, run);
      await setPhase("verified");
      await gate(options, state);
      await setPhase("cutover");
    }
    if (state.phase === "cutover") {
      await stopHelper(state, run);
      const staging = await mounted(paths.staging, run);
      if (staging) {
        await verifyMount(paths, state, paths.staging, run, deps);
        await run("umount", [paths.staging]);
      }
      const live = await mounted(paths.canonical, run);
      if (!live) {
        await gate(options, state);
        let retired = await metadata(state.retired, true);
        if (!retired) {
          const source = await lstat(paths.canonical);
          if (!source.isDirectory() || !same(fingerprint(source), state.sourceIdentity))
            throw new Error("Source directory changed before handoff");
          await rename(paths.canonical, state.retired);
          await syncDirectory(dirname(paths.canonical));
          retired = await lstat(state.retired);
        }
        if (!retired.isDirectory() || !same(fingerprint(retired), state.sourceIdentity))
          throw new Error("Retired directory identity changed");
        await emptyMountpoint(paths.canonical);
        await (deps.chown ?? chown)(paths.canonical, 1000, 1000);
        await installSystemd(paths, state, run, deps, true);
      }
      await verifyMount(paths, state, paths.canonical, run, deps);
      await setPhase("mounted");
    }
    if (state.phase === "mounted") {
      await verifyMount(paths, state, paths.canonical, run, deps);
      await quotaSession(paths, state, paths.canonical, run, deps, async (request) => {
        for (const entry of state.workspaces) {
          const {
            revision: _revision,
            capacityBytes: _capacity,
            ...identity
          } = quotaRequest(entry);
          const quota = await request("/v1/quota/read", identity);
          if (
            quota.state !== "ready" ||
            quota.revision !== entry.revision ||
            quota.capacityBytes !== entry.capacityBytes
          )
            throw new Error("Remounted quota identity changed");
          await quotaRoots(paths.canonical, entry, run, state.filesystemId);
        }
      });
      await copyAndVerify(state.retired, paths.canonical, run, false);
      await setPhase("retiring");
    }
    if (state.phase === "retiring") {
      await gate(options, state);
      await stopHelper(state, run);
      await verifyMount(paths, state, paths.canonical, run, deps);
      const retired = await metadata(state.retired, true);
      if (retired) {
        if (!retired.isDirectory() || !same(fingerprint(retired), state.sourceIdentity))
          throw new Error("Unverified retired directory cannot be removed");
        await noNestedMounts(state.retired, deps);
        if (await mounted(state.retired, run)) throw new Error("Retired source is still mounted");
        // The durable retiring phase follows a full checksum/metadata proof.
        // A resumed recursive removal may already have changed old directory
        // mtimes or removed some children; do not mistake that for copy damage.
        // The verified destination UUID and old root inode still must match.
        await run(
          "rm",
          ["--recursive", "--one-file-system", "--preserve-root", "--", state.retired],
          { timeoutMs: 6 * 60 * 60_000 },
        );
      }
      if (await metadata(state.retired, true))
        throw new Error("Retired source removal is unconfirmed");
      await syncDirectory(dirname(paths.canonical));
      await setPhase("complete");
    }
    return {
      state: state.phase,
      filesystemId: state.filesystemId,
      poolBytes: state.poolBytes,
      paths,
    };
  });
}

export async function verifyWorkspaceStoragePool(options, deps = {}) {
  const paths = workspacePoolPaths(options.runtimeDirectory),
    state = await readState(paths);
  if (!state || state.phase !== "complete")
    throw new Error("Workspace storage pool has not completed its owned migration");
  await verifyMount(paths, state, paths.canonical, deps.run ?? storagePoolCommand, deps);
  if (await metadata(state.retired, true))
    throw new Error("Retired source has not been physically removed");
  return { state: "complete", filesystemId: state.filesystemId, poolBytes: state.poolBytes, paths };
}
export async function growWorkspaceStoragePool(options, deps = {}) {
  return withLock(options, deps, async (paths, run) => {
    await verifyWorkspaceStoragePool(options, { ...deps, run });
    const state = await readState(paths);
    const target = bytes(options.poolBytes, "Pool growth target", 512 * 1024 ** 2);
    const image = await imageIdentity(paths, state);
    if (target < state.poolBytes || target < image.size || target < (state.growthTargetBytes ?? 0))
      throw new Error("Workspace pool cannot shrink");
    state.growthTargetBytes = target;
    await saveState(paths, state);
    const mount = await verifyMount(paths, state, paths.canonical, run, deps);
    if (image.size < target) await run("truncate", ["--size", String(target), "--", paths.image]);
    await run("losetup", ["--set-capacity", mount.source]);
    await run("xfs_growfs", ["-d", paths.canonical], { timeoutMs: 120_000 });
    await run("sync", ["--file-system", paths.canonical], { timeoutMs: 120_000 });
    await verifyMount(paths, state, paths.canonical, run, deps);
    if ((await imageIdentity(paths, state)).size !== target)
      throw new Error("Pool backing-file growth was not confirmed");
    const geometry = (await run("xfs_info", [paths.canonical])).stdout.match(
      /data\s*=\s*bsize=(\d+)\s+blocks=(\d+)/,
    );
    if (!geometry || Number(geometry[1]) * Number(geometry[2]) !== target)
      throw new Error("XFS data-section growth was not confirmed");
    state.poolBytes = target;
    delete state.growthTargetBytes;
    await saveState(paths, state);
    return {
      state: "complete",
      filesystemId: state.filesystemId,
      poolBytes: state.poolBytes,
      paths,
    };
  });
}
