import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const source = await mkdtemp(join(tmpdir(), "pi-cloud-volume-review-"));
const repository = process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox");
try {
  execFileSync("git", [
    "-C",
    repository,
    "archive",
    "--format=tar",
    `--output=${source}/source.tar`,
    manifest.upstreamCommit,
  ]);
  execFileSync("tar", ["-xf", `${source}/source.tar`, "-C", source]);
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      patch.sha256,
    );
    execFileSync("git", ["apply", path], { cwd: source });
  }
  await copyFile(
    new URL("reference_review_test.go", import.meta.url),
    join(source, "Cubelet/plugins/volume/reference_review_test.go"),
  );
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--memory=1g",
      "--cpus=2",
      "--tmpfs",
      "/test-tmp:exec,mode=1777",
      "-e",
      "TMPDIR=/test-tmp",
      "-e",
      "GOTMPDIR=/tmp",
      "-v",
      `${source}:/source:ro`,
      "-v",
      `${resolve(root, "deploy/cubesandbox/cube-volume-picloud-posix.sh")}:/posix-plugin:ro`,
      "-e",
      "PI_CLOUD_POSIX_PLUGIN=/posix-plugin",
      "-w",
      "/source/Cubelet",
      "-e",
      `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
      ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
        .filter((k) => process.env[k])
        .flatMap((k) => ["-e", k]),
      manifest.buildImages.go,
      "go",
      "test",
      "-mod=readonly",
      "-race",
      "-count=1",
      "-exec",
      "env GOTMPDIR=/test-tmp",
      "-v",
      "./plugins/volume/...",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const code = await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => ok(code));
  });
  assert.equal(code, 0);
} finally {
  await rm(source, { recursive: true, force: true });
}
