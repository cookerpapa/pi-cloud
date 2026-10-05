// Isolated characterization of the reviewed native Volume/plugin boundary.
// The operator checkout is read via git archive; no VM or Workspace is modified.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const repository = resolve(
  process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
);
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-review-20261005-"));
const exec = promisify(execFile);
try {
  await exec("git", [
    "-C",
    repository,
    "archive",
    "--format=tar",
    `--output=${join(directory, "source.tar")}`,
    manifest.upstreamCommit,
  ]);
  await exec("tar", ["-xf", join(directory, "source.tar"), "-C", directory]);
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== patch.sha256
    )
      throw new Error("Cube patch digest mismatch");
    await exec("git", ["apply", path], { cwd: directory });
  }
  await copyFile(
    join(root, "scripts/review-20261005-cube/attach_recovery_test.go"),
    join(directory, "Cubelet/plugins/volume/review_attach_recovery_test.go"),
  );
  await copyFile(
    join(root, "deploy/cubesandbox/cube-volume-picloud-posix.sh"),
    join(directory, "review-posix.sh"),
  );
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--memory=1g",
      "--cpus=2",
      "-v",
      `${directory}:/source:ro`,
      "-w",
      "/source/Cubelet",
      "-e",
      "PI_CLOUD_REVIEW_VOLUME_PLUGIN=/source/review-posix.sh",
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
      "-run",
      "TestReview",
      "-v",
      "./plugins/volume",
    ],
    { cwd: root, stdio: "inherit" },
  );
  await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`Review fixture failed (${code})`)),
    );
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
