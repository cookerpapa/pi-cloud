import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(root, "upstream-driver.json"), "utf8"));
const target = join(root, "driver"),
  manifest = join(target, "package.json");
const expected = existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined;
const temporary = mkdtempSync(join(tmpdir(), "pi-android-driver-"));
try {
  const archive = join(temporary, "driver.tgz");
  execFileSync("curl", ["--fail", "--location", "--retry", "3", pin.url, "-o", archive], {
    stdio: "inherit",
  });
  assert.equal(
    "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64"),
    pin.integrity,
  );
  mkdirSync(target, { recursive: true });
  // Keep upstream driver code/APKs/licenses unchanged. Resolve its bundled JS
  // dependencies through our one lockfile so maintained patch overrides apply.
  execFileSync("tar", [
    "-xzf",
    archive,
    "-C",
    target,
    "--strip-components=1",
    "--exclude=package/node_modules",
  ]);
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(pkg.name, pin.name);
  assert.equal(pkg.version, pin.version);
  delete pkg.bundleDependencies;
  delete pkg.bundledDependencies;
  // npm does not override an optional dependency pinned inside a linked package.
  assert.equal(pkg.optionalDependencies.sharp, "0.35.4");
  pkg.optionalDependencies.sharp = "0.35.5";
  const normalized = JSON.stringify(pkg, null, 2) + "\n";
  if (expected !== undefined)
    assert.deepEqual(pkg, JSON.parse(expected), "Review the pinned upstream driver manifest");
  writeFileSync(manifest, normalized);
  console.log("Android driver source integrity verified; upstream code unchanged");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
