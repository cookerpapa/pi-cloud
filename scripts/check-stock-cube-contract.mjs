import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
assert.match(manifest.upstreamCommit, /^[0-9a-f]{40}$/);
assert.equal(manifest.providerContractVersion, 1);
for (const obsolete of [
  "patches",
  "buildImages",
  "managedProtocolVersion",
  "lifecycleHistoryVersion",
])
  assert.equal(manifest[obsolete], undefined, `Retired Cube extension input: ${obsolete}`);
assert.deepEqual(Object.keys(manifest.nativeImages).sort(), [
  "cube-api",
  "cube-master",
  "cube-templatecenter",
  "cubelet",
]);
for (const [name, source] of Object.entries(manifest.nativeImages)) {
  assert.equal(source.platform, "linux/amd64");
  const prefix = `cube-sandbox-int.tencentcloudcr.com/cube-sandbox/${name}:v${manifest.upstreamVersion}@sha256:`;
  assert(
    source.reference.startsWith(prefix) &&
      /^[0-9a-f]{64}$/.test(source.reference.slice(prefix.length)),
    "Native Cube artifact is not pinned",
  );
}
const files = await readdir(resolve(root, "deploy/cubesandbox"), { recursive: true });
assert(
  !files.some((file) => file.endsWith(".patch")),
  "Cube source patches remain in the maintained deployment",
);
console.log(
  "stock_cube_contract_passed immutable_upstream_inputs no_engine_patches no_dependency_overlays",
);
