import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../local-kubernetes-pi-workers.mjs", import.meta.url), "utf8");
// Exercise the actual CLI coordination functions without starting a cluster.
function load(name, dependencies) {
  const declaration = source.match(new RegExp(`^async function ${name}\\([^]*?^}`, "m"))?.[0];
  if (!declaration) throw new Error(`Missing CLI function ${name}`);
  return runInNewContext(`(${declaration})`, { AggregateError, ...dependencies });
}

function fixture(failAt) {
  const calls = [];
  const step = (name, result) => async () => {
    calls.push(name);
    if (failAt === name) throw new Error(name);
    return result;
  };
  const previous = { composeWorkers: [] };
  return {
    calls,
    dependencies: {
      ensureK3d: step("ensure"),
      repositoryRevision: step("revision", "a".repeat(40)),
      readRuntimeEnvironment: step("environment", { PI_CLOUD_PI_WORKER_DEPLOYMENT: "compose" }),
      activeRunCount: step("active", 0),
      ensureCluster: step("cluster"),
      bridgeComposeServices: step("bridges", []),
      buildAndImportWorkerImage: step("image", { tag: "image" }),
      captureComposeSwitchState: step("capture", previous),
      switchControlPlaneToKubernetes: step("switch", previous),
      deployWorkerPool: step("deploy"),
      checkDeployment: step("check"),
      removeKubernetesWorkerPool: step("remove"),
      restoreComposeWorkers: step("restore"),
      process: { stderr: { write() {} } },
    },
  };
}

describe("local Worker deployment rollback", () => {
  it("resolves Compose addresses after recreating Control Plane", async () => {
    const { dependencies } = fixture();
    let address = "old-container-ip";
    dependencies.switchControlPlaneToKubernetes = async () => {
      address = "new-container-ip";
    };
    dependencies.bridgeComposeServices = async () => [{ address }];
    let deployed;
    dependencies.deployWorkerPool = async (_tag, targets) => {
      deployed = targets;
    };
    await load("up", dependencies)();
    expect(deployed).toEqual([{ address: "new-container-ip" }]);
  });

  it("does not cut over if a Run arrived while building the image", async () => {
    const { calls, dependencies } = fixture();
    let checked = 0;
    dependencies.activeRunCount = async () => checked++;
    await expect(load("up", dependencies)()).rejects.toThrow("1 Run(s)");
    expect(calls).not.toContain("switch");
  });

  it("does not report a ready old image as the requested revision", async () => {
    await expect(
      load("checkDeployment", {
        ensureK3d: async () => {},
        readRuntimeEnvironment: async () => ({ PI_CLOUD_PI_WORKER_DEPLOYMENT: "kubernetes" }),
        workerNamespace: "workers",
        poolName: "test",
        workerReplicas: 1,
        kubectlCapture: async () =>
          JSON.stringify({
            items: [
              {
                metadata: { name: "worker-0" },
                status: { conditions: [{ type: "Ready", status: "True" }] },
                spec: {
                  containers: [{ name: "pi-worker", image: "pi-cloud/supervisor-host:old" }],
                },
              },
            ],
          }),
        composeContainer: async () => {
          throw new Error("should validate image before route probes");
        },
      })("a".repeat(40)),
    ).rejects.toThrow("does not run pi-cloud/supervisor-host:kubernetes-aaaaaaaaaaaa");
  });

  it("waits for remaining executor Pods after Helm confirms deletion", async () => {
    const calls = [];
    await load("removeKubernetesWorkerPool", {
      helm: "helm",
      releaseName: "workers",
      workerNamespace: "workers",
      poolName: "test",
      kubeEnvironment: () => ({}),
      run: async (_binary, args) => calls.push(args),
      kubectlRun: async (args) => calls.push(args),
    })();
    expect(calls[0]).toContain("--ignore-not-found");
    expect(calls[0]).toContain("--wait");
    expect(calls[1]).toContain("--for=delete");
  });

  it("retains rollback state even if the control-plane switch fails partway through", async () => {
    const { calls, dependencies } = fixture("switch");
    await expect(load("up", dependencies)()).rejects.toThrow("switch");
    expect(calls.slice(-2)).toEqual(["remove", "restore"]);
  });

  it("removes the failed Kubernetes pool before restoring Compose", async () => {
    const { calls, dependencies } = fixture("deploy");
    await expect(load("up", dependencies)()).rejects.toThrow("deploy");
    expect(calls.slice(-2)).toEqual(["remove", "restore"]);
  });

  it("does not start Compose when Kubernetes shutdown cannot be confirmed", async () => {
    const { calls, dependencies } = fixture("deploy");
    dependencies.removeKubernetesWorkerPool = async () => {
      calls.push("remove");
      throw new Error("Kubernetes unreachable");
    };
    const error = await load("up", dependencies)().catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((item) => item.message)).toEqual(["deploy", "Kubernetes unreachable"]);
    expect(calls).not.toContain("restore");
  });

  it("downgrade stops on a failed uninstall, preserving the previous mode", async () => {
    const { calls, dependencies } = fixture();
    const down = load("down", {
      ...dependencies,
      readFile: async () => JSON.stringify({ formatVersion: 2, composeWorkers: [] }),
      switchStatePath: "owned-switch-state",
      k3dClusterExists: async () => true,
      capture: async () => "kubeconfig",
      k3d: "k3d",
      helm: "helm",
      clusterName: "test",
      releaseName: "test",
      workerNamespace: "test",
      runtimeKubeconfigPath: "owned-kubeconfig",
      writePrivate: async () => {},
      kubeEnvironment: () => ({}),
      run: async () => {
        throw new Error("uninstall failed");
      },
      removeKubernetesWorkerPool: async () => {
        throw new Error("uninstall failed");
      },
      rm: async () => {},
    });
    await expect(down()).rejects.toThrow("uninstall failed");
    expect(calls).not.toContain("restore");
  });

  it("never starts a previously stopped Worker", async () => {
    const calls = [];
    await load("restoreComposeWorkers", {
      replaceRuntimeEnvironment: async () => {},
      waitForComposeHealthy: async () => {},
      productionCompose: async (args, revision) => calls.push({ args, revision }),
    })({
      piWorkerDeployment: "compose",
      supervisorIdPrefix: "worker-",
      supervisorManagementUrlTemplate: "http://{supervisorId}:4100",
      controlPlaneImageRevision: "control-revision",
      composeWorkers: [
        { service: "supervisor-host", running: true },
        { service: "supervisor-host-1", running: false },
      ],
    });
    expect(calls).toEqual([
      { args: ["up", "--detach", "--no-deps", "control-plane"], revision: "control-revision" },
      { args: ["up", "--detach", "--no-deps", "supervisor-host"], revision: undefined },
      { args: ["up", "--no-start", "--no-deps", "supervisor-host-1"], revision: undefined },
    ]);
  });
});
