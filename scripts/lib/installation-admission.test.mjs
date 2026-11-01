import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertFirstInstallation, installedMarkers } from "./installation-admission.mjs";

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const runtimeDirectory = mkdtempSync(resolve(tmpdir(), "pi-install-admission-"));
  directories.push(runtimeDirectory);
  mkdirSync(resolve(runtimeDirectory, "k3s"));
  const kubeconfig = resolve(runtimeDirectory, "k3s/kubeconfig.yaml");
  return { runtimeDirectory, kubeconfig };
}
it("permits a fresh installation and refuses an unreadable or already installed cluster", () => {
  const f = fixture(),
    readReleases = vi.fn(() => []);
  expect(() => assertFirstInstallation({ ...f, readReleases })).not.toThrow();
  expect(readReleases).not.toHaveBeenCalled();
  writeFileSync(f.kubeconfig, "fixture");
  expect(() => assertFirstInstallation({ ...f, readReleases })).not.toThrow();
  expect(readReleases).toHaveBeenCalledOnce();
  expect(() =>
    assertFirstInstallation({ ...f, readReleases: () => [{ name: "pi-cloud" }] }),
  ).toThrow("already installed");
  expect(() =>
    assertFirstInstallation({
      ...f,
      readReleases: () => {
        throw new Error("cluster unavailable");
      },
    }),
  ).toThrow("cluster unavailable");
});
it.each(installedMarkers)("rejects %s before consulting Helm", (marker) => {
  const f = fixture(),
    readReleases = vi.fn();
  writeFileSync(resolve(f.runtimeDirectory, marker), "{}");
  expect(() => assertFirstInstallation({ ...f, readReleases })).toThrow("already installed");
  expect(readReleases).not.toHaveBeenCalled();
});
it.each([
  ["node", "scripts/run-production-install.mjs"],
  ["node", "scripts/production-kubernetes.mjs", "bootstrap"],
  ["node", "scripts/production-kubernetes.mjs", "build"],
  ["bash", "scripts/install-self-hosted.sh", "--yes"],
])("refuses an existing installation before any command mutation: %s %s", (command, ...args) => {
  const f = fixture();
  writeFileSync(resolve(f.runtimeDirectory, "k3s/deployment.json"), "{}");
  if (command === "bash") args.push("--runtime-dir", f.runtimeDirectory);
  const result = spawnSync(command === "node" ? process.execPath : command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CLOUD_RUNTIME_DIRECTORY: f.runtimeDirectory,
      PI_CLOUD_RELEASE_LOCKED: "",
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/already installed/);
  expect(readdirSync(f.runtimeDirectory)).toEqual(["k3s"]);
  expect(readdirSync(resolve(f.runtimeDirectory, "k3s"))).toEqual(["deployment.json"]);
  expect(existsSync(resolve(f.runtimeDirectory, ".env"))).toBe(false);
});
it("removes the old direct deploy action before even reading runtime configuration", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ["scripts/production-kubernetes.mjs", "deploy"], {
    encoding: "utf8",
    env: { ...process.env, PI_CLOUD_RUNTIME_DIRECTORY: f.runtimeDirectory },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Direct deployment is removed/);
  expect(readdirSync(resolve(f.runtimeDirectory, "k3s"))).toEqual([]);
});
