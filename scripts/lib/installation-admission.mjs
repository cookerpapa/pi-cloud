import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const installedMarkers = ["k3s/deployment.json", "k3s/bootstrap-completed.json"];
export const installedMessage =
  "PiCloud is already installed; use docs/MATCHED_RELEASE.md or docs/COMPONENT_RELEASE.md, not the installer";

/** Read-only, including on an unavailable cluster. No initialization/build belongs here. */
export function assertFirstInstallation({
  runtimeDirectory,
  kubeconfig,
  helm = process.env.PI_CLOUD_HELM_BIN ?? "helm",
  readReleases = () =>
    JSON.parse(
      execFileSync(
        helm,
        [
          "list",
          "--all",
          "--kubeconfig",
          kubeconfig,
          "--namespace",
          "cube-system",
          "--filter",
          "^pi-cloud$",
          "--output",
          "json",
        ],
        { encoding: "utf8", timeout: 30_000 },
      ),
    ),
}) {
  assert(
    !installedMarkers.some((path) => existsSync(resolve(runtimeDirectory, path))),
    installedMessage,
  );
  if (!existsSync(kubeconfig)) return;
  const releases = readReleases(); // Unknown is not permission to overwrite an installation.
  assert(Array.isArray(releases), "Invalid Helm installation inventory");
  assert.equal(releases.length, 0, installedMessage);
}
