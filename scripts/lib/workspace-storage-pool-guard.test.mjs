import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceStoragePoolGuard,
  isK3sStorageProcess,
} from "./workspace-storage-pool-guard.mjs";
import { normalizeWorkspacePoolPlan, workspacePoolPaths } from "./workspace-storage-pool.mjs";

const directories = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const GiB = 1024 ** 3;
const inactive = () => ({
  LoadState: "loaded",
  ActiveState: "inactive",
  SubState: "dead",
  MainPID: "0",
  ControlPID: "0",
  ExecMainStartTimestampMonotonic: "0",
});

async function fixture({ journal = true, phase = "copying", image = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloud-cold-proof-"));
  directories.push(directory);
  const runtimeDirectory = join(directory, "runtime"),
    paths = workspacePoolPaths(runtimeDirectory);
  await mkdir(paths.control, { recursive: true, mode: 0o700 });
  const options = {
    runtimeDirectory,
    domainId: "sandbox-domain-0001",
    sourceId: "workspace:sandbox-domain-0001",
    poolBytes: 64 * GiB,
    workspaces: normalizeWorkspacePoolPlan([
      {
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
        generation: "a".repeat(64),
        revision: 1,
        capacityBytes: 32 * GiB,
      },
    ]),
    quotaHelper: {
      binary: join(directory, "workspace-quota"),
      tokenFile: join(directory, "token"),
      meteringTokenFile: join(directory, "metering-token"),
      meteringUrl: "http://127.0.0.1:0/internal/v1/resource-metering",
      listen: "127.0.0.1:14510",
    },
  };
  const planPath = join(directory, "workspace-storage-plan.json"),
    proofPath = join(paths.control, "cold-operation-proof.json");
  const savePlan = (value = options, suffix = "\n") =>
    writeFile(planPath, JSON.stringify(value, null, 2) + suffix, { mode: 0o600 });
  await savePlan();
  const operation = {
    version: 1,
    id: randomUUID(),
    filesystemId: randomUUID(),
    paths,
    sourceId: options.sourceId,
    fresh: false,
    phase,
    poolBytes: options.poolBytes,
    sourceIdentity: { dev: "1", ino: "2" },
    ...(image ? { imageIdentity: { dev: "1", ino: "3" } } : {}),
    workspaces: options.workspaces.map((entry) => ({
      ...entry,
      source: { dev: "1", ino: "4" },
      usedBytes: 1024,
    })),
  };
  const saveOperation = (value = operation) =>
    writeFile(paths.journal, JSON.stringify(value), { mode: 0o600 });
  if (journal) await saveOperation();
  let host = { bootId: randomUUID(), machineSha256: hash("same owned host") };
  let service = inactive(),
    processes = [];
  const inventory = ["control-plane", "api", "master", "cube-node"].map((component) => ({
    kind: component === "cube-node" ? "DaemonSet" : "Deployment",
    metadata: {
      name: component,
      uid: randomUUID(),
      labels: { "app.kubernetes.io/component": component },
    },
    spec: { replicas: 0 },
    status: { desiredNumberScheduled: 0 },
  }));
  const authority = {
    close: vi.fn(async () => {}),
    schema: vi.fn(async () => [{ name: "212_workspace_capacity" }]),
    assertDrained: vi.fn(async () => {}),
    uploads: vi.fn(async () => [{ working: 0, retained: 0 }]),
    targets: vi.fn(async () => []),
    workspaces: vi.fn(async () =>
      options.workspaces.map((entry) => ({
        tenant_id: entry.tenantId,
        id: entry.workspaceId,
        capacity_revision: String(entry.revision),
        capacity_bytes: String(entry.capacityBytes),
      })),
    ),
  };
  const deps = {
    planPath,
    k3sInstalled: vi.fn(async () => true),
    openOnline: vi.fn(async () => authority),
    readHostIdentity: vi.fn(async () => ({ ...host })),
    readK3sState: vi.fn(async () => ({ ...service })),
    readProcesses: vi.fn(async () => [...processes]),
    run: vi.fn(async (command, args) => {
      expect(command).toBe("/usr/local/bin/k3s");
      expect(args).toContain("deployments,statefulsets,daemonsets,pods");
      return { stdout: JSON.stringify({ items: inventory }), code: 0 };
    }),
  };
  const readProof = async () => JSON.parse(await readFile(proofPath, "utf8"));
  const onlineProof = async () => {
    const guard = await createWorkspaceStoragePoolGuard(options, deps);
    try {
      expect(guard.mode).toBe("online");
      await guard.assertQuiescent();
    } finally {
      await guard.close();
    }
    return readProof();
  };
  return {
    options,
    paths,
    operation,
    planPath,
    proofPath,
    deps,
    authority,
    inventory,
    savePlan,
    saveOperation,
    readProof,
    onlineProof,
    reboot: () => {
      host = { ...host, bootId: randomUUID() };
    },
    foreignHost: () => {
      host = { bootId: randomUUID(), machineSha256: hash("another machine") };
    },
    service: (value) => {
      service = { ...inactive(), ...value };
    },
    processes: (value) => {
      processes = value;
    },
  };
}

it("creates a private proof only after online schema, drain, physical retirement, upload and exact inventory checks", async () => {
  const f = await fixture();
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  await expect(readFile(f.proofPath)).rejects.toMatchObject({ code: "ENOENT" });
  try {
    await guard.assertQuiescent();
    for (const operation of [
      f.authority.schema,
      f.authority.assertDrained,
      f.authority.uploads,
      f.authority.targets,
      f.authority.workspaces,
    ])
      expect(operation).toHaveBeenCalledOnce();
    const proof = await f.readProof();
    expect(proof.scope.planSha256).toBe(hash(await readFile(f.planPath)));
    expect(proof.scope.paths).toEqual(f.paths);
    expect(proof.operation.binding).toMatchObject({
      id: f.operation.id,
      filesystemId: f.operation.filesystemId,
      sourceIdentity: f.operation.sourceIdentity,
    });
    expect(proof.operation.imageIdentity).toEqual(f.operation.imageIdentity);
    expect(proof.checks).toMatchObject({
      schemaVersion: 212,
      physicalRetirementComplete: true,
      workloadsStopped: true,
    });
    expect((await stat(f.proofPath)).mode & 0o077).toBe(0);
    expect(await readFile(f.proofPath, "utf8")).not.toContain("Bearer");
  } finally {
    await guard.close();
  }
});

it.each(["schema", "drain", "uploads", "physical", "plan", "pods"])(
  "cannot create a cold proof when the actual online %s check fails",
  async (failure) => {
    const f = await fixture();
    if (failure === "schema") f.authority.schema.mockResolvedValue([]);
    if (failure === "drain")
      f.authority.assertDrained.mockRejectedValue(new Error("PG leases remain"));
    if (failure === "uploads") f.authority.uploads.mockResolvedValue([{ working: 1, retained: 0 }]);
    if (failure === "physical")
      f.authority.targets.mockResolvedValue([{ allocationId: randomUUID() }]);
    if (failure === "plan") f.authority.workspaces.mockResolvedValue([]);
    if (failure === "pods")
      f.inventory.push({
        kind: "Pod",
        metadata: { labels: { "app.kubernetes.io/component": "cube-node" } },
      });
    const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
    try {
      await expect(guard.assertQuiescent()).rejects.toThrow();
    } finally {
      await guard.close();
    }
    await expect(readFile(f.proofPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("resumes the same unfinished operation after a host reboot without contacting PG, Kubernetes or a receiver", async () => {
  const f = await fixture();
  await f.onlineProof();
  const before = await readFile(f.proofPath, "utf8");
  f.reboot();
  f.deps.run.mockClear();
  f.deps.openOnline.mockClear();
  f.deps.openOnline.mockRejectedValue(new Error("PG unavailable"));
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  expect(guard.mode).toBe("offline_resume");
  await expect(guard.assertQuiescent()).resolves.toEqual({
    runtimeQuiescent: true,
    physicalVMsAbsent: true,
    schemaVersion: 212,
  });
  await f.saveOperation({ ...f.operation, phase: "retiring" });
  await guard.assertQuiescent();
  expect(f.deps.run).not.toHaveBeenCalled();
  expect(f.deps.openOnline).not.toHaveBeenCalled();
  expect(await readFile(f.proofPath, "utf8")).toBe(before); // Proof is not a renewable lease.
  await guard.close();
});

it("same-boot PG failure never reuses even a previously valid cold proof", async () => {
  const f = await fixture();
  await f.onlineProof();
  f.deps.openOnline.mockRejectedValue(new Error("PG unavailable"));
  await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow("Same-boot");
  expect(f.deps.readProcesses).not.toHaveBeenCalled();
});

it("also fails closed when a same-boot PG check stalls or fails after connection setup", async () => {
  const f = await fixture();
  await f.onlineProof();
  const before = await readFile(f.proofPath, "utf8");
  f.authority.schema.mockRejectedValue(new Error("PG query unavailable"));
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  try {
    await expect(guard.assertQuiescent()).rejects.toThrow("Same-boot");
  } finally {
    await guard.close();
  }
  expect(await readFile(f.proofPath, "utf8")).toBe(before);
});

it("a new boot with active K3s still requires the normal live checks and has no offline fallback", async () => {
  const f = await fixture();
  await f.onlineProof();
  f.reboot();
  f.service({
    ActiveState: "active",
    SubState: "running",
    MainPID: "123",
    ExecMainStartTimestampMonotonic: "1234",
  });
  f.deps.openOnline.mockRejectedValueOnce(new Error("PG unavailable"));
  await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(
    "PG unavailable",
  );
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  expect(guard.mode).toBe("online");
  await guard.assertQuiescent();
  await guard.close();
  expect(f.deps.readProcesses).not.toHaveBeenCalled();
});

it.each(["capacity", "generation", "helper", "whitespace"])(
  "rejects a changed private %s plan after reboot",
  async (field) => {
    const f = await fixture();
    await f.onlineProof();
    f.reboot();
    if (field === "capacity") {
      f.options.workspaces[0].capacityBytes = 40 * GiB;
      f.options.workspaces[0].revision = 2;
    }
    if (field === "generation") f.options.workspaces[0].generation = "b".repeat(64);
    if (field === "helper") f.options.quotaHelper.binary += "-replacement";
    await f.savePlan(f.options, field === "whitespace" ? "\n\n" : "\n");
    f.deps.openOnline.mockClear();
    await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(
      /changed|differs/,
    );
    expect(f.deps.openOnline).not.toHaveBeenCalled();
  },
);

it.each(["json", "physical", "version", "permissions"])(
  "rejects a corrupt or unsafe %s proof after reboot",
  async (failure) => {
    const f = await fixture();
    const proof = await f.onlineProof();
    f.reboot();
    if (failure === "physical") proof.checks.physicalRetirementComplete = false;
    if (failure === "version") proof.version = 2;
    await writeFile(f.proofPath, failure === "json" ? "{" : JSON.stringify(proof));
    if (failure === "permissions") await chmod(f.proofPath, 0o644);
    await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(
      /proof|checks/,
    );
  },
);

it.each([
  { ActiveState: "deactivating", SubState: "stop-sigterm" },
  { MainPID: "123" },
  { ControlPID: "456" },
  { LoadState: "not-found" },
  { ExecMainStartTimestampMonotonic: "321" },
])("rejects unconfirmed K3s inactivity or any prior startup in the new boot: %j", async (state) => {
  const f = await fixture();
  await f.onlineProof();
  f.reboot();
  f.service(state);
  await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(/K3s|online/);
});

it.each([
  { executable: "/var/lib/rancher/k3s/data/release/bin/containerd", args: ["containerd"] },
  {
    executable: "/usr/bin/containerd",
    args: ["containerd", "-c", "/var/lib/rancher/k3s/agent/etc/containerd/config.toml"],
  },
  {
    executable: "/usr/bin/containerd-shim-runc-v2",
    args: ["shim", "-namespace", "k8s.io", "-address", "/run/k3s/containerd/containerd.sock"],
  },
  { executable: "/usr/local/bin/k3s", args: ["k3s", "server"] },
])("refuses a K3s runtime or orphan shim despite MainPID=0: %j", async (process) => {
  const f = await fixture();
  await f.onlineProof();
  f.reboot();
  f.processes([process]);
  await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow("still runs");
});

it("does not stop or confuse the unrelated Docker builder with K3s containerd", async () => {
  const process = {
    executable: "/usr/bin/containerd",
    args: ["containerd", "--config", "/etc/containerd/config.toml"],
  };
  expect(isK3sStorageProcess(process)).toBe(false);
  const f = await fixture();
  await f.onlineProof();
  f.reboot();
  f.processes([process]);
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  expect(guard.mode).toBe("offline_resume");
  await guard.close();
});

it.each(["missing", "id", "filesystem", "source", "image", "host"])(
  "does not authorize a different or missing %s operation",
  async (failure) => {
    const f = await fixture();
    await f.onlineProof();
    f.reboot();
    if (failure === "missing") await rm(f.paths.journal);
    if (failure === "id") await f.saveOperation({ ...f.operation, id: randomUUID() });
    if (failure === "filesystem")
      await f.saveOperation({ ...f.operation, filesystemId: randomUUID() });
    if (failure === "source")
      await f.saveOperation({ ...f.operation, sourceIdentity: { dev: "1", ino: "999" } });
    if (failure === "image")
      await f.saveOperation({ ...f.operation, imageIdentity: { dev: "1", ino: "999" } });
    if (failure === "host") f.foreignHost();
    await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(
      /operation|identity|host/,
    );
  },
);

it("requires an online proof bound after journal creation, before permitting reboot continuation of initial formatting", async () => {
  const f = await fixture({ journal: false, phase: "preparing", image: false });
  const first = await f.onlineProof();
  expect(first.operation).toBeNull();
  await f.saveOperation();
  f.reboot();
  await expect(createWorkspaceStoragePoolGuard(f.options, f.deps)).rejects.toThrow(
    "new pool operation",
  );
  // Live authority, rather than a missing runtime, is needed to bind the new journal.
  f.service({
    ActiveState: "active",
    SubState: "running",
    MainPID: "123",
    ExecMainStartTimestampMonotonic: "5",
  });
  await f.onlineProof();
  f.reboot();
  f.service({});
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  expect(guard.mode).toBe("offline_resume");
  await guard.assertQuiescent();
  await guard.close();
});

it("rechecks plan, proof and process absence at each offline filesystem boundary", async () => {
  const f = await fixture();
  await f.onlineProof();
  f.reboot();
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  f.processes([{ executable: "/var/lib/rancher/k3s/data/new/bin/containerd", args: [] }]);
  await expect(guard.assertQuiescent()).rejects.toThrow("still runs");
  f.processes([]);
  await f.savePlan(f.options, "\n\n");
  await expect(guard.assertQuiescent()).rejects.toThrow("plan changed");
  await guard.close();
});

it("fresh installation never fabricates PG retirement proof or enters the reboot continuation", async () => {
  const f = await fixture();
  f.options.fresh = true;
  await f.savePlan();
  const guard = await createWorkspaceStoragePoolGuard(f.options, f.deps);
  expect(guard.mode).not.toBe("offline_resume");
  await expect(guard.assertQuiescent()).rejects.toThrow("cannot bypass");
  await expect(readFile(f.proofPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.deps.openOnline).not.toHaveBeenCalled();
  await guard.close();
});
