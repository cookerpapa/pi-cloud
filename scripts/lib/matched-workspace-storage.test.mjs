import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopNativeStorageConsumers } from "./matched-workspace-storage.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "picloud-native-stop-"));
  directories.push(directory);
  const items = ["cube-api", "cube-master", "cube-node", "cube-node-bootstrap"].map((name, i) => ({
    kind: i < 2 ? "Deployment" : "DaemonSet",
    metadata: { name, uid: `${name}-uid`, generation: 1 },
    spec: {
      ...(i < 2 ? { replicas: 1 } : {}),
      selector: { matchLabels: { component: name } },
      template: { spec: { nodeSelector: { original: "node" } } },
    },
    status: { observedGeneration: 1, desiredNumberScheduled: 1, currentNumberScheduled: 1 },
  }));
  const calls = [],
    pods = new Set(items.map((item) => item.metadata.name));
  let replaceUid = false;
  const kubectl = vi.fn((args) => {
    calls.push(args);
    if (args[0] === "get" && args.includes("--ignore-not-found")) return JSON.stringify({ items });
    if (args[0] === "get" && args[1] === "pods") {
      const name = args[args.indexOf("-l") + 1].split("=")[1];
      return JSON.stringify({ items: pods.has(name) ? [{ metadata: { name } }] : [] });
    }
    if (args[0] === "wait") {
      pods.delete(args[args.indexOf("-l") + 1].split("=")[1]);
      return "";
    }
    const name = args[1].split("/")[1];
    const item = items.find((entry) => entry.metadata.name === name);
    if (args[0] === "get") {
      if (replaceUid && name === "cube-node-bootstrap") item.metadata.uid = "replacement";
      return JSON.stringify(item);
    }
    if (args[0] === "scale") item.spec.replicas = Number(args[2].split("=")[1]);
    else if (args[0] === "patch") {
      item.spec.template.spec.nodeSelector = JSON.parse(args.at(-1))[0].value;
      item.metadata.generation++;
    } else if (args[0] !== "rollout") throw new Error(`Unexpected ${args}`);
    return "";
  });
  const delay = vi.fn(async () => {
    for (const item of items.filter((item) => item.kind === "DaemonSet")) {
      if (item.spec.template.spec.nodeSelector["pi-cloud.io/workspace-storage-maintenance"]) {
        item.status = {
          observedGeneration: item.metadata.generation,
          desiredNumberScheduled: 0,
          currentNumberScheduled: 0,
        };
      }
    }
  });
  return {
    directory,
    items,
    calls,
    kubectl,
    delay,
    replaceUid: () => {
      replaceUid = true;
    },
  };
}

it("stops bootstrap too, waits for controller convergence and restores dependencies before readiness", async () => {
  const f = await fixture();
  const restore = await stopNativeStorageConsumers(f);
  expect(f.delay).toHaveBeenCalled();
  const record = JSON.parse(await readFile(join(f.directory, "native-storage-maintenance.json")));
  expect(record.resources).toHaveLength(4);
  expect(record.restored).toBe(false);
  for (const item of f.items.filter((item) => item.kind === "DaemonSet")) {
    expect(item.status.desiredNumberScheduled).toBe(0);
    expect(item.status.observedGeneration).toBe(item.metadata.generation);
  }
  f.calls.length = 0;
  await restore();
  const firstReadiness = f.calls.findIndex((args) => args[0] === "rollout");
  expect(
    f.calls.slice(0, firstReadiness).filter((args) => ["patch", "scale"].includes(args[0])),
  ).toHaveLength(4);
  for (const item of f.items)
    expect(item.spec.template.spec.nodeSelector).toEqual({ original: "node" });
  expect(
    JSON.parse(await readFile(join(f.directory, "native-storage-maintenance.json"))).restored,
  ).toBe(true);
});

it("rejects a replaced bootstrap workload while waiting for stop", async () => {
  const f = await fixture();
  f.replaceUid();
  await expect(stopNativeStorageConsumers(f)).rejects.toThrow("identity changed");
  expect(f.calls.some((args) => args[0] === "rollout")).toBe(false);
});

it("template maintenance requires and stops TemplateCenter and lifecycle writers too", async () => {
  const f = await fixture();
  await expect(stopNativeStorageConsumers({ ...f, templateMaintenance: true })).rejects.toThrow(
    "cube-templatecenter",
  );
  for (const name of ["cube-templatecenter", "cube-lifecycle-manager"]) {
    const item = structuredClone(f.items[0]);
    item.metadata.name = name;
    item.metadata.uid = `${name}-uid`;
    item.spec.selector.matchLabels = { component: name };
    f.items.push(item);
  }
  const restore = await stopNativeStorageConsumers({ ...f, templateMaintenance: true });
  expect(f.items.slice(-2).map((v) => v.spec.replicas)).toEqual([0, 0]);
  await restore();
  expect(f.items.slice(-2).map((v) => v.spec.replicas)).toEqual([1, 1]);
});
