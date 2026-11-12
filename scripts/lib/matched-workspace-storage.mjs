import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, chmod, open, rename, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readPrivateRuntimeFile } from "./runtime-file-policy.mjs";
import { workspaceVolumeId } from "../../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";

const maintenanceLabel = "pi-cloud.io/workspace-storage-maintenance";
const recordedPath = (directory) => resolve(directory, "native-storage-maintenance.json");
export function rootCommand(command, args, root) {
  const options = { cwd: root, stdio: "inherit" };
  if (process.geteuid() === 0) return execFileSync(command, args, options);
  if (process.env.WSL_DISTRO_NAME)
    return execFileSync(
      "wsl.exe",
      ["-d", process.env.WSL_DISTRO_NAME, "-u", "root", "--", command, ...args],
      options,
    );
  return execFileSync("sudo", ["-n", command, ...args], options);
}

/** Reboot recovery precedes K3s image import/PG access. Mutation authorization
 * is checked by the fixed root CLI against its bound cold-operation proof. */
export async function resumeColdMatchedStorage({ directory, runtimeDirectory, root, kubectl }) {
  if (!(await nativeStorageMaintenancePending(directory))) return;
  const active = execFileSync("systemctl", ["show", "k3s", "--property=ActiveState", "--value"], {
    encoding: "utf8",
  }).trim();
  if (active === "active") return;
  assert(
    ["inactive", "failed"].includes(active),
    "K3s is changing state; cold storage recovery remains unconfirmed",
  );
  const planPath = resolve(directory, "workspace-storage-plan.json");
  const plan = JSON.parse(
    await readPrivateRuntimeFile(planPath, 16 * 1024 ** 2, "Workspace migration plan"),
  );
  assert.equal(plan.runtimeDirectory, runtimeDirectory, "Saved storage recovery scope changed");
  // Only the root CLI reads the root-owned pool journal. Completed operations
  // take its read-only verification path; unfinished operations require proof.
  rootCommand(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, "scripts/run-workspace-storage-pool.mjs"),
      "prepare",
      "--plan",
      planPath,
    ],
    root,
  );
  rootCommand("systemctl", ["start", "k3s"], root);
  // All application/native desired states remain stopped. Restore only the
  // existing infrastructure needed to re-run the normal live PG/Kube guards.
  kubectl(["rollout", "status", "statefulset/postgres", "--timeout=300s"], { timeout: 305_000 });
}
async function saveMaintenance(path, state) {
  const temporary = `${path}.next-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function nativeStorageMaintenancePending(directory) {
  try {
    return !JSON.parse(await readFile(recordedPath(directory), "utf8")).restored;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Called only after native all-node absence and the PG retirement receipts.
 * Keep a private resume record; a failed filesystem handoff stays offline. */
export async function stopNativeStorageConsumers({
  directory,
  kubectl,
  delay = sleep,
  templateMaintenance = false,
}) {
  const live = JSON.parse(
    kubectl([
      "get",
      "deployment/cube-api",
      "deployment/cube-master",
      ...(templateMaintenance
        ? ["deployment/cube-templatecenter", "deployment/cube-lifecycle-manager"]
        : []),
      "daemonset/cube-node",
      "daemonset/cube-node-bootstrap",
      "statefulset/pi-cloud-boxlite",
      "--ignore-not-found",
      "-o",
      "json",
    ]),
  ).items;
  for (const name of [
    "cube-api",
    "cube-master",
    "cube-node",
    ...(templateMaintenance ? ["cube-templatecenter", "cube-lifecycle-manager"] : []),
  ])
    assert(
      live.some((item) => item.metadata.name === name),
      `Missing native workload ${name}`,
    );
  let state;
  try {
    state = JSON.parse(await readFile(recordedPath(directory), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      version: 1,
      id: randomUUID(),
      restored: false,
      resources: live.map((item) => ({
        kind: item.kind,
        name: item.metadata.name,
        uid: item.metadata.uid,
        replicas: item.spec.replicas,
        nodeSelector: item.spec.template.spec.nodeSelector,
      })),
    };
    await saveMaintenance(recordedPath(directory), state);
  }
  assert.equal(state.version, 1);
  state.restored = false;
  await saveMaintenance(recordedPath(directory), state);
  for (const saved of state.resources) {
    const current = live.find(
      (item) => item.kind === saved.kind && item.metadata.name === saved.name,
    );
    assert.equal(current?.metadata.uid, saved.uid, "Native storage workload identity changed");
    const target = `${saved.kind.toLowerCase()}/${saved.name}`;
    if (saved.kind === "DaemonSet")
      kubectl([
        "patch",
        target,
        "--type=json",
        "-p",
        JSON.stringify([
          {
            op: "add",
            path: "/spec/template/spec/nodeSelector",
            value: { ...saved.nodeSelector, [maintenanceLabel]: state.id },
          },
        ]),
      ]);
    else kubectl(["scale", target, "--replicas=0"]);
    const selector = Object.entries(current.spec.selector.matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    if (JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items.length)
      kubectl(["wait", "--for=delete", "pod", "-l", selector, "--timeout=180s"], {
        timeout: 185_000,
      });
    if (saved.kind === "DaemonSet") {
      const deadline = performance.now() + 180_000;
      for (;;) {
        const object = JSON.parse(kubectl(["get", target, "-o", "json"]));
        assert.equal(object.metadata.uid, saved.uid, "Native storage workload identity changed");
        assert.equal(object.spec.template.spec.nodeSelector[maintenanceLabel], state.id);
        const pods = JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items;
        if (
          object.status?.observedGeneration >= object.metadata.generation &&
          object.status.desiredNumberScheduled === 0 &&
          object.status.currentNumberScheduled === 0 &&
          pods.length === 0
        )
          break;
        assert(performance.now() < deadline, "Native storage DaemonSet has not stopped");
        await delay(250);
      }
    }
  }
  return async () => {
    for (const saved of state.resources) {
      const target = `${saved.kind.toLowerCase()}/${saved.name}`;
      const current = JSON.parse(kubectl(["get", target, "-o", "json"]));
      assert.equal(
        current.metadata.uid,
        saved.uid,
        "Native storage workload changed during migration",
      );
      if (saved.kind === "DaemonSet")
        kubectl([
          "patch",
          target,
          "--type=json",
          "-p",
          JSON.stringify([
            saved.nodeSelector
              ? {
                  op: "replace",
                  path: "/spec/template/spec/nodeSelector",
                  value: saved.nodeSelector,
                }
              : { op: "remove", path: "/spec/template/spec/nodeSelector" },
          ]),
        ]);
      else kubectl(["scale", target, `--replicas=${saved.replicas}`]);
    }
    // Start every dependency before awaiting readiness: API needs Master, and
    // node registration also needs Master. Waiting inside the scale loop deadlocks.
    for (const saved of state.resources) {
      const target = `${saved.kind.toLowerCase()}/${saved.name}`;
      const current = JSON.parse(kubectl(["get", target, "-o", "json"]));
      assert.equal(current.metadata.uid, saved.uid, "Native storage workload identity changed");
      if (saved.kind === "StatefulSet" && current.spec.updateStrategy?.type === "OnDelete") {
        // Cold maintenance removed the old Pods. OnDelete has no rollout-status
        // watch: require the controller and its newly created Pods to be ready.
        const selector = Object.entries(current.spec.selector.matchLabels)
          .map(([key, value]) => `${key}=${value}`)
          .join(",");
        const deadline = performance.now() + 300_000;
        for (;;) {
          const object = JSON.parse(kubectl(["get", target, "-o", "json"]));
          assert.equal(object.metadata.uid, saved.uid, "Native storage workload identity changed");
          const pods = JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items;
          if (
            object.status?.observedGeneration >= object.metadata.generation &&
            pods.length === saved.replicas &&
            pods.every(
              (pod) =>
                !pod.metadata.deletionTimestamp &&
                pod.metadata.ownerReferences?.some((owner) => owner.uid === saved.uid) &&
                pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
            )
          )
            break;
          assert(performance.now() < deadline, "Native storage StatefulSet is not ready");
          await delay(250);
        }
      } else kubectl(["rollout", "status", target, "--timeout=300s"], { timeout: 305_000 });
    }
    state.restored = true;
    await saveMaintenance(recordedPath(directory), state);
  };
}

export async function prepareMatchedWorkspaceStorage({
  database,
  directory,
  runtimeDirectory,
  root,
  domainId,
  image,
}) {
  const planPath = resolve(directory, "workspace-storage-plan.json");
  let savedPlan;
  try {
    savedPlan = JSON.parse(
      await readPrivateRuntimeFile(planPath, 16 * 1024 ** 2, "Workspace migration plan"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (savedPlan) {
    assert(
      savedPlan.runtimeDirectory === runtimeDirectory &&
        savedPlan.domainId === domainId &&
        savedPlan.quotaHelper?.binary === resolve(directory, "workspace-quota"),
      "Saved Workspace migration plan changed scope",
    );
  }
  const rows = await database
    .selectFrom("workspaces")
    .select(["id", "tenant_id", "capacity_bytes", "capacity_revision"])
    .where("sandbox_domain_id", "=", domainId)
    .where("deleted_at", "is", null)
    .orderBy("id")
    .execute();
  const workspaces = [];
  for (const row of savedPlan ? [] : rows) {
    const identity = { tenantId: row.tenant_id, workspaceId: row.id };
    const volumeId = workspaceVolumeId(identity);
    let generation = null;
    try {
      const text = await readFile(
        resolve(
          runtimeDirectory,
          "state/cube-shared/volume",
          `picloud-posix-${volumeId}`,
          ".pi-cloud-runtime/identity",
        ),
        "utf8",
      );
      const lines = text.split("\n");
      assert(
        lines.length === 4 &&
          lines[0] === "pi-cloud-volume-v1" &&
          lines[1] === volumeId &&
          /^[a-f0-9]{64}$/.test(lines[2]),
        "Workspace Volume identity changed",
      );
      generation = lines[2];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    workspaces.push({
      ...identity,
      volumeId,
      generation,
      revision: Number(row.capacity_revision),
      capacityBytes: Number(row.capacity_bytes),
    });
  }
  const binary = resolve(directory, "workspace-quota");
  const container = `pi-cloud-quota-extract-${randomUUID()}`;
  const execute = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
  execute("docker", ["create", "--name", container, image]);
  try {
    execute("docker", ["cp", `${container}:/app/bin/workspace-quota`, binary]);
  } finally {
    execute("docker", ["rm", container]);
  }
  await chmod(binary, 0o755);
  // The canonical path can be temporarily absent after the original directory
  // is renamed. Retain the exact generation inventory; the root CLI rechecks PG.
  if (!savedPlan)
    await saveMaintenance(planPath, {
      runtimeDirectory,
      domainId,
      sourceId: `workspace:${domainId}`,
      workspaces,
      quotaHelper: {
        binary,
        tokenFile: resolve(runtimeDirectory, "secrets/workspace-volume-gateway-token"),
        meteringTokenFile: resolve(runtimeDirectory, "secrets/metering-ingest-token"),
        // The normal receiver resumes after migration. The source outbox retains
        // these first receipts without relying on Kubernetes DNS on the host.
        meteringUrl: "http://127.0.0.1:0/internal/v1/resource-metering",
        listen: "127.0.0.1:14510",
      },
    });
  const nodeArgs = [
    "--import",
    resolve(root, "node_modules/tsx/dist/loader.mjs"),
    resolve(root, "scripts/run-workspace-storage-pool.mjs"),
    "prepare",
    "--plan",
    planPath,
  ];
  if (process.geteuid() === 0) execute(process.execPath, nodeArgs);
  else if (process.env.WSL_DISTRO_NAME)
    execute("wsl.exe", [
      "-d",
      process.env.WSL_DISTRO_NAME,
      "-u",
      "root",
      "--",
      process.execPath,
      ...nodeArgs,
    ]);
  else execute("sudo", ["-n", process.execPath, ...nodeArgs]);
  // This runs while all native storage consumers are still stopped. It does not
  // touch Workspace bytes or discard an uncertain attachment.
  rootCommand(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, "scripts/run-workspace-storage-pool.mjs"),
      "attachments",
      "--plan",
      planPath,
    ],
    root,
  );
  rootCommand(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, "scripts/run-workspace-storage-pool.mjs"),
      "persistence",
      "--plan",
      planPath,
    ],
    root,
  );
}
