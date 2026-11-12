import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join, resolve, basename } from "node:path";
import { lstat, open, readFile, readdir, readlink, rename, unlink } from "node:fs/promises";
import { readPrivateRuntimeFile } from "./runtime-file-policy.mjs";
import {
  normalizeWorkspacePoolPlan,
  storagePoolCommand,
  workspacePoolPaths,
  DEFAULT_WORKSPACE_POOL_BYTES,
} from "./workspace-storage-pool.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const proofChecks = Object.freeze({
  schemaVersion: 212,
  runtimeQuiescent: true,
  uploadsSettled: true,
  physicalRetirementComplete: true,
  workloadsStopped: true,
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const proofPath = (paths) => join(paths.control, "cold-operation-proof.json");
const identity = (value) => value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
const phases = new Set([
  "preparing",
  "formatted",
  "copying",
  "verified",
  "cutover",
  "mounted",
  "retiring",
  "complete",
]);

const stopped = new Set([
  "control-plane",
  "session-runtime",
  "trusted-pi-worker",
  "web",
  "ssh-gateway",
  "workspace-volume-gateway",
  "workspace-quota",
  "api",
  "master",
  "cube-node",
  "cube-node-pvm",
]);
function usesVolume(object, canonical) {
  const spec = object.kind === "Pod" ? object.spec : object.spec?.template?.spec;
  return spec?.volumes?.some((volume) => {
    const path = volume.hostPath?.path;
    return (
      typeof path === "string" &&
      (path === canonical ||
        path.startsWith(canonical + "/") ||
        canonical.startsWith(path.replace(/\/$/, "") + "/"))
    );
  });
}
export function assertWorkspaceStorageProcessesStopped(inventory, canonical, fresh = false) {
  assert(Array.isArray(inventory), "Missing actual Kubernetes storage inventory");
  if (fresh)
    assert(
      !inventory.some(
        (item) => item.metadata?.labels?.["app.kubernetes.io/component"] === "control-plane",
      ),
      "Fresh installation cannot bypass an existing deployment's PG retirement proof",
    );
  if (!fresh)
    assert(
      inventory.some(
        (item) =>
          item.kind !== "Pod" &&
          item.metadata?.labels?.["app.kubernetes.io/component"] === "control-plane",
      ),
      "Control Plane workload inventory is missing",
    );
  for (const object of inventory) {
    const component = object.metadata?.labels?.["app.kubernetes.io/component"];
    if (!stopped.has(component) && !usesVolume(object, canonical)) continue;
    assert.notEqual(
      object.kind,
      "Pod",
      "Workspace admission/runtime/native Pods have not physically exited",
    );
    if (object.kind === "DaemonSet")
      assert.equal(
        object.status?.desiredNumberScheduled,
        0,
        "A native storage DaemonSet can still start Pods",
      );
    else assert.equal(object.spec?.replicas ?? 1, 0, "A Workspace writer workload is not stopped");
  }
}

async function hostIdentity() {
  const [boot, machine] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/etc/machine-id", "utf8"),
  ]);
  assert(
    UUID.test(boot.trim()) && /^[0-9a-f]{32}$/.test(machine.trim()),
    "Host reboot identity is unavailable",
  );
  return { bootId: boot.trim(), machineSha256: sha256(machine.trim()) };
}

async function k3sInstalled() {
  const existing = await Promise.all(
    ["/usr/local/bin/k3s", "/etc/systemd/system/k3s.service"].map((path) =>
      lstat(path).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    ),
  );
  return existing.some(Boolean);
}

/** The deployment's Docker builder may remain up. Only the maintained K3s
 * runtime and its surviving shims prevent this cold filesystem continuation. */
export function isK3sStorageProcess(process) {
  const executable = process.executable.replace(/ \(deleted\)$/, "");
  const name = basename(executable);
  const args = process.args;
  if (
    (name === "k3s" || name === "k3s-server") &&
    (name === "k3s-server" || args.includes("server") || args.includes("agent"))
  )
    return true;
  const runtime = name === "containerd" || name.startsWith("containerd-shim");
  const scoped =
    /\/var\/lib\/rancher\/k3s(?:\/|$)/.test(executable) ||
    args.some((value) => /(?:^|=)\/(?:run\/k3s|var\/lib\/rancher\/k3s)(?:\/|$)/.test(value));
  return runtime && (scoped || args.includes("k8s.io"));
}

async function processInventory() {
  const processes = [];
  const entries = await readdir("/proc");
  assert(entries.length <= 65536, "Host process inventory exceeds the cold-operation bound");
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const [executable, command] = await Promise.all([
        readlink(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/cmdline`),
      ]);
      assert(command.length <= 1024 * 1024, "Host process arguments exceed the inspection bound");
      processes.push({
        pid: Number(pid),
        executable,
        args: command.toString("utf8").split("\0").filter(Boolean),
      });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return processes;
}

async function k3sState(run) {
  const result = await run(
    "systemctl",
    [
      "show",
      "k3s.service",
      "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ExecMainStartTimestampMonotonic",
    ],
    { allowedExitCodes: [0, 1, 4] },
  );
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

function assertK3sNeverStarted(state) {
  assert(
    state.LoadState === "loaded" &&
      ["inactive", "failed"].includes(state.ActiveState) &&
      ["dead", "failed"].includes(state.SubState) &&
      state.MainPID === "0" &&
      state.ControlPID === "0",
    "Offline storage resume requires positively inactive K3s with no processes",
  );
  assert.equal(
    state.ExecMainStartTimestampMonotonic,
    "0",
    "K3s has already run in this boot; fresh online PG and Kubernetes checks are required",
  );
}

async function ownedJSON(path, maximum, label) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const metadata = await file.stat();
    assert(
      metadata.isFile() &&
        metadata.nlink === 1 &&
        metadata.uid === process.geteuid() &&
        (metadata.mode & 0o077) === 0 &&
        metadata.size > 0 &&
        metadata.size <= maximum,
      `${label} is not a private operator-owned bounded file`,
    );
    try {
      return JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error(`${label} is corrupt`);
    }
  } finally {
    await file.close();
  }
}

async function readProof(paths) {
  const proof = await ownedJSON(proofPath(paths), 256 * 1024, "Cold operation proof");
  if (!proof) return undefined;
  assert(
    proof.version === 1 &&
      proof.kind === "workspace-storage-cold-operation" &&
      UUID.test(proof.host?.bootId) &&
      SHA256.test(proof.host?.machineSha256) &&
      SHA256.test(proof.scope?.planSha256) &&
      SHA256.test(proof.scope?.workspacesSha256) &&
      SHA256.test(proof.workloadsSha256) &&
      Number.isSafeInteger(proof.workloadCount) &&
      proof.workloadCount > 0 &&
      Number.isFinite(Date.parse(proof.observedAt)),
    "Cold operation proof is invalid",
  );
  assert.deepEqual(proof.checks, proofChecks, "Cold operation proof lacks verified online checks");
  return proof;
}

async function writeProof(paths, proof) {
  const directory = await lstat(paths.control);
  assert(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === process.geteuid() &&
      (directory.mode & 0o077) === 0,
    "Cold proof requires the private operator-owned pool control directory",
  );
  const temporary = `${proofPath(paths)}.next-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(proof) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, proofPath(paths));
    const parent = await open(paths.control, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function frozenPlan(options, path) {
  assert(
    typeof path === "string" && resolve(path) === path,
    "Cold storage guard requires the exact private plan path",
  );
  const metadata = await lstat(path);
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      (metadata.mode & 0o077) === 0,
    "Cold storage plan is not a private regular file",
  );
  const raw = await readPrivateRuntimeFile(path, 16 * 1024 ** 2, "Workspace migration plan");
  assert.deepEqual(JSON.parse(raw), options, "Private migration plan changed after it was loaded");
  const workspaces = normalizeWorkspacePoolPlan(options.workspaces);
  return {
    workspaces,
    scope: {
      planPath: path,
      planSha256: sha256(raw),
      paths: workspacePoolPaths(options.runtimeDirectory),
      sourceId: options.sourceId,
      domainId: options.domainId,
      poolBytes: options.poolBytes ?? DEFAULT_WORKSPACE_POOL_BYTES,
      workspacesSha256: sha256(JSON.stringify(workspaces)),
    },
  };
}

async function operationBinding(paths, options, plan) {
  const state = await ownedJSON(paths.journal, 16 * 1024 ** 2, "Workspace pool journal");
  if (!state) return undefined;
  assert(
    state.version === 1 &&
      state.fresh === false &&
      UUID.test(state.id) &&
      UUID.test(state.filesystemId) &&
      phases.has(state.phase) &&
      identity(state.sourceIdentity),
    "Cold proof needs the existing owned pool operation",
  );
  assert.deepEqual(state.paths, paths, "Cold pool operation paths changed");
  assert.equal(state.sourceId, options.sourceId, "Cold pool operation source changed");
  assert.equal(
    state.poolBytes,
    options.poolBytes ?? DEFAULT_WORKSPACE_POOL_BYTES,
    "Cold pool operation capacity changed",
  );
  const selected = new Map(plan.map((entry) => [entry.volumeId, entry]));
  const existing = normalizeWorkspacePoolPlan(state.workspaces);
  const originals = new Map(state.workspaces.map((entry) => [entry.volumeId, entry]));
  const sources = existing.map((entry) => {
    const expected = selected.get(entry.volumeId);
    assert(
      expected &&
        expected.generation !== null &&
        expected.tenantId === entry.tenantId &&
        expected.workspaceId === entry.workspaceId &&
        expected.generation === entry.generation &&
        expected.revision >= entry.revision &&
        expected.capacityBytes >= entry.capacityBytes &&
        (expected.revision !== entry.revision || expected.capacityBytes === entry.capacityBytes),
      "Cold pool operation differs from its frozen Workspace plan",
    );
    const original = originals.get(entry.volumeId);
    assert(identity(original.source), "Cold operation source inode is missing");
    return {
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
      volumeId: entry.volumeId,
      generation: entry.generation,
      source: original.source,
    };
  });
  if (state.imageIdentity)
    assert(identity(state.imageIdentity), "Cold operation image inode is invalid");
  return {
    phase: state.phase,
    binding: {
      id: state.id,
      filesystemId: state.filesystemId,
      sourceId: state.sourceId,
      sourceIdentity: state.sourceIdentity,
      poolBytes: state.poolBytes,
      sourcesSha256: sha256(JSON.stringify(sources)),
    },
    ...(state.imageIdentity ? { imageIdentity: state.imageIdentity } : {}),
  };
}

async function openOnlineAuthority({ paths, options, kubectl }) {
  const { sql } = await import("kysely");
  const { createDatabase } = await import("../../packages/database/src/index.ts");
  const { createComputeRetirementRepository } = await import("./compute-retirement-postgres.mjs");
  const endpoint = new URL(
    (
      await readPrivateRuntimeFile(
        resolve(paths.runtime, "secrets/database-url"),
        64 * 1024,
        "Database credential",
      )
    ).trim(),
  );
  const postgres = JSON.parse((await kubectl(["get", "service", "postgres", "-o", "json"])).stdout);
  assert(
    typeof postgres.spec?.clusterIP === "string" && postgres.spec.clusterIP !== "None",
    "PostgreSQL service address is unavailable",
  );
  endpoint.hostname = postgres.spec.clusterIP;
  const database = createDatabase({
    connectionString: endpoint.toString(),
    maxConnections: 1,
    readTimeoutMs: 5000,
  });
  const repository = createComputeRetirementRepository(database);
  return {
    database,
    close: () => database.destroy(),
    schema: async () =>
      (
        await sql`select name from kysely_migration where name='212_workspace_capacity'`.execute(
          database,
        )
      ).rows,
    assertDrained: () => repository.assertDrained(),
    uploads: async () =>
      (
        await sql`select
      (select count(*) from workspace_file_transfers where state='uploading')::int as working,
      (select count(*) from session_uploads where state='uploading')::int as retained`.execute(
          database,
        )
      ).rows,
    targets: () => repository.listTargets(),
    workspaces: async () =>
      (
        await sql`select tenant_id,id,capacity_revision,capacity_bytes from workspaces
      where sandbox_domain_id=${options.domainId} and deleted_at is null order by id limit 20001`.execute(
          database,
        )
      ).rows,
  };
}

/** Normal continuation reads live retirement authority. The only offline path
 * reuses its private, same-operation proof after a host reboot before K3s starts.
 * Absent processes never establish physical retirement or create that proof. */
export async function createWorkspaceStoragePoolGuard(options, deps = {}) {
  const paths = workspacePoolPaths(options.runtimeDirectory);
  const run = deps.run ?? storagePoolCommand;
  const kubeconfig = resolve(options.kubeconfig ?? resolve(paths.runtime, "k3s/kubeconfig.yaml"));
  const kubectl = (args) =>
    run("/usr/local/bin/k3s", [
      "kubectl",
      "--kubeconfig",
      kubeconfig,
      "-n",
      "cube-system",
      ...args,
    ]);
  const processes = async () => {
    if (options.fresh) {
      if (!(await (deps.k3sInstalled ?? k3sInstalled)())) return; // Genuinely before K3s installation.
    }
    const body = await kubectl(["get", "deployments,statefulsets,daemonsets,pods", "-o", "json"]);
    const items = JSON.parse(body.stdout).items;
    assertWorkspaceStorageProcessesStopped(items, paths.canonical, options.fresh === true);
    return items;
  };
  if (options.fresh) return { assertQuiescent: processes, close: async () => {} };
  assert(
    typeof options.domainId === "string" &&
      options.domainId.length > 0 &&
      options.sourceId === `workspace:${options.domainId}`,
    "Workspace pool domain/source identity changed",
  );
  const selected = await frozenPlan(options, deps.planPath);
  const readHost = deps.readHostIdentity ?? hostIdentity;
  const initialHost = await readHost();
  assert(
    UUID.test(initialHost.bootId) && SHA256.test(initialHost.machineSha256),
    "Invalid host identity",
  );
  const proof = await readProof(paths);
  const operation = await operationBinding(paths, options, selected.workspaces);
  if (proof && proof.host.bootId !== initialHost.bootId && operation?.phase !== "complete") {
    // Decide before discovering a Service or opening PG. Active K3s uses the
    // ordinary online path; an unavailable service never implies cold authority.
    const readService = deps.readK3sState ?? (() => k3sState(run));
    const current = await readService();
    if (!["active", "activating", "reloading"].includes(current.ActiveState)) {
      assert.equal(
        initialHost.machineSha256,
        proof.host.machineSha256,
        "Cold proof belongs to another host",
      );
      assert.deepEqual(proof.scope, selected.scope, "Cold proof private plan changed");
      assert(
        proof.operation && operation,
        "Offline storage resume cannot create a new pool operation",
      );
      const assertOffline = async () => {
        assert.deepEqual(
          await readHost(),
          initialHost,
          "Host identity changed during cold continuation",
        );
        const present = await frozenPlan(options, deps.planPath);
        assert.deepEqual(present.scope, selected.scope, "Cold proof private plan changed");
        assert.deepEqual(
          await readProof(paths),
          proof,
          "Cold operation proof changed during continuation",
        );
        const owned = await operationBinding(paths, options, present.workspaces);
        assert(
          owned && owned.phase !== "complete",
          "Offline storage resume requires the unfinished owned operation",
        );
        assert.deepEqual(owned.binding, proof.operation.binding, "Cold operation identity changed");
        if (proof.operation.imageIdentity)
          assert.deepEqual(
            owned.imageIdentity,
            proof.operation.imageIdentity,
            "Cold operation backing identity changed",
          );
        assertK3sNeverStarted(await readService());
        const active = await (deps.readProcesses ?? processInventory)();
        assert(
          !active.some(isK3sStorageProcess),
          "K3s containerd, shim or server still runs; offline storage continuation is refused",
        );
        return { runtimeQuiescent: true, physicalVMsAbsent: true, schemaVersion: 212 };
      };
      await assertOffline();
      return { mode: "offline_resume", assertQuiescent: assertOffline, close: async () => {} };
    }
  }
  let authority;
  try {
    authority = await (deps.openOnline ?? openOnlineAuthority)({ paths, options, kubectl });
  } catch (cause) {
    if (proof?.host.bootId === initialHost.bootId)
      throw new Error(
        "Same-boot storage continuation requires fresh online PG and Kubernetes checks",
        { cause },
      );
    throw cause;
  }
  const plan = selected.workspaces;
  const checkOnline = async () => {
    const workloads = await processes();
    assert.equal(
      (await authority.schema()).length,
      1,
      "Workspace capacity schema 212 is not installed",
    );
    await authority.assertDrained();
    const uploads = await authority.uploads();
    assert(
      uploads.length === 1 && uploads[0].working === 0 && uploads[0].retained === 0,
      "Uploads must settle before their inode-bound storage moves",
    );
    assert.equal(
      (await authority.targets()).length,
      0,
      "Managed VM physical retirement is not durably confirmed",
    );
    const current = (await authority.workspaces())
      .map((row) => ({
        tenantId: row.tenant_id,
        workspaceId: row.id,
        revision: Number(row.capacity_revision),
        capacityBytes: Number(row.capacity_bytes),
      }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    const expected = plan
      .map(({ tenantId, workspaceId, revision, capacityBytes }) => ({
        tenantId,
        workspaceId,
        revision,
        capacityBytes,
      }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    assert.deepEqual(
      current,
      expected,
      "PG Workspace identities/capacities changed after the operator plan",
    );
    assert.deepEqual(
      (await frozenPlan(options, deps.planPath)).scope,
      selected.scope,
      "Private plan changed during online verification",
    );
    assert.deepEqual(
      await readHost(),
      initialHost,
      "Host identity changed during online verification",
    );
    const owned = await operationBinding(paths, options, plan);
    const observed = workloads
      .filter(
        (item) =>
          stopped.has(item.metadata?.labels?.["app.kubernetes.io/component"]) ||
          usesVolume(item, paths.canonical),
      )
      .map((item) => ({
        kind: item.kind,
        name: item.metadata.name,
        uid: item.metadata.uid,
        component: item.metadata.labels?.["app.kubernetes.io/component"] ?? null,
        desired:
          item.kind === "DaemonSet"
            ? item.status.desiredNumberScheduled
            : (item.spec?.replicas ?? 1),
      }))
      .sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
    if (owned?.phase !== "complete")
      await writeProof(paths, {
        version: 1,
        kind: "workspace-storage-cold-operation",
        host: initialHost,
        scope: selected.scope,
        checks: proofChecks,
        observedAt: new Date().toISOString(),
        workloadCount: observed.length,
        workloadsSha256: sha256(JSON.stringify(observed)),
        operation: owned
          ? {
              binding: owned.binding,
              ...(owned.imageIdentity ? { imageIdentity: owned.imageIdentity } : {}),
            }
          : null,
      });
    return { runtimeQuiescent: true, physicalVMsAbsent: true, schemaVersion: 212 };
  };
  return {
    mode: "online",
    database: authority.database,
    close: () => authority.close(),
    assertQuiescent: async () => {
      try {
        return await checkOnline();
      } catch (cause) {
        if (proof?.host.bootId === initialHost.bootId)
          throw new Error(
            `Same-boot storage continuation requires fresh online checks: ${cause.message}`,
            { cause },
          );
        throw cause;
      }
    },
  };
}
