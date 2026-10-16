import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = "deploy/cubesandbox/runtime-build.json";
const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-result-review-"));
const fixtures = join(temporary, "fixtures");
const native = join(temporary, "Cubelet");
const run = async (command, args, options = {}) => {
  const r = await exec(command, args, {
    cwd: root,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return r.stdout;
};
try {
  await run("git", [
    "-C",
    process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
    "archive",
    "--format=tar",
    `--output=${join(temporary, "source.tar")}`,
    manifest.upstreamCommit,
  ]);
  await run("tar", ["-xf", join(temporary, "source.tar"), "-C", temporary]);
  await rm(join(temporary, "source.tar"));
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      patch.sha256,
    );
    await run("git", ["apply", path], { cwd: temporary });
  }
  const nativeBaseline = await run("go", ["test", "-mod=readonly", "-race", "./pkg/execution"], {
    cwd: native,
  });
  await run(process.execPath, [join(here, "guest.mjs"), fixtures]);
  await copyFile(
    join(here, "native_review_test.go"),
    join(native, "pkg/execution/review_result_test.go"),
  );
  const nativeProbes = await run(
    "go",
    ["test", "-mod=readonly", "-race", "-run", "^TestReview", "-v", "./pkg/execution"],
    {
      cwd: native,
      env: { ...process.env, REVIEW_FIXTURES: fixtures },
    },
  );
  const sourceSha256 = {};
  for (const path of [
    manifestPath,
    "packages/tool-sandbox/src/cube-tool-scope.ts",
    "packages/tool-sandbox/src/envd-tool-exec.ts",
    "packages/tool-sandbox/src/native-tools.ts",
    "packages/tool-sandbox/src/native-tool-output.ts",
    "packages/cube-completion/src/adapter.ts",
  ])
    sourceSha256[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  const evidence = {
    reviewedRevision: (await run("git", ["rev-parse", "HEAD"])).trim(),
    checkedAt: new Date().toISOString(),
    cubeCommit: manifest.upstreamCommit,
    goVersion: (await run("go", ["version"], { cwd: native })).trim(),
    nodeVersion: process.version,
    productionMutations: false,
    liveVmFaultInjection: false,
    guestFixture:
      "actual guest and launcher on local PTY; privilege launch and cgroup calls substituted",
    nativeFixture:
      "actual driver, parser and containerd FIFO I/O; process/task services substituted",
    guest: JSON.parse(await readFile(join(fixtures, "guest-evidence.json"), "utf8")),
    nativeBaseline: nativeBaseline.trim(),
    nativeProbes: nativeProbes.trim().split("\n"),
    sourceSha256,
  };
  const path = join(root, "docs/reports/guest-cubelet-result-review-20261016.json");
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(nativeProbes.trim());
  console.log(`Evidence: ${path}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
