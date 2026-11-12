import { expect, it } from "vitest";
import { stringify } from "yaml";
import { cubeUpgradeAlreadyApplied } from "./cube-upgrade-plan.mjs";
import { cubeReleaseDigest } from "./cube-release-policy.mjs";
import { manifestDigest } from "./component-release.mjs";

it("publishes changed mount configuration while reusing the native images and values", () => {
  const values = { image: "stock-cube:unchanged" };
  const manifest = (mode) =>
    stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "mount-plugin" },
      data: { mode },
    });
  const before = manifest("old"),
    desired = manifest("independent-storage");
  const plan = {
    valuesDigest: cubeReleaseDigest(values),
    baselineValuesDigest: cubeReleaseDigest(values),
    baselineManifestDigest: manifestDigest(before),
  };
  expect(cubeUpgradeAlreadyApplied(plan, { values, manifest: before }, desired)).toBe(false);
  expect(cubeUpgradeAlreadyApplied(plan, { values, manifest: desired }, desired)).toBe(true);
  expect(() =>
    cubeUpgradeAlreadyApplied(plan, { values, manifest: manifest("unrelated-operator") }, desired),
  ).toThrow("Installed Cube manifest changed");
  expect(() =>
    cubeUpgradeAlreadyApplied(plan, { values: { image: "another" }, manifest: before }, desired),
  ).toThrow("Installed Cube overrides changed");
});
