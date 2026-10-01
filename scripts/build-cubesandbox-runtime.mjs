import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, copyFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const tag = process.env.PI_CLOUD_IMAGE_VERSION ?? "production";
if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error("Invalid Cube image tag");
const sourceRepository = resolve(
  process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
);
const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-cube-build-"));
const run = (command, args, cwd = root) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)),
    );
  });
try {
  // Export the pinned commit; never edit the operator's checkout or include its
  // uncommitted files, diagnostics, credentials or generated binaries.
  await run("git", [
    "-C",
    sourceRepository,
    "archive",
    "--format=tar",
    `--output=${join(temporary, "source.tar")}`,
    manifest.upstreamCommit,
  ]);
  await run("tar", ["-xf", "source.tar"], temporary);
  await rm(join(temporary, "source.tar"));
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== patch.sha256
    )
      throw new Error(`Cube patch digest changed: ${patch.file}`);
    await run("git", ["apply", "--check", path], temporary);
    await run("git", ["apply", path], temporary);
  }
  const patchId = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 16);
  for (const [name, file, context] of [
    ["cube-api", "CubeAPI/Dockerfile", "CubeAPI"],
    ["cube-master", "CubeMaster/docker/Dockerfile", "."],
    ["cubelet-base", "Cubelet/Dockerfile", "."],
  ]) {
    const original = join(temporary, file),
      dockerfile = join(temporary, `${name}.Dockerfile`);
    let text = await readFile(original, "utf8");
    const pins = new Map([
      ["golang:1.25-bookworm", manifest.buildImages.go],
      ["rust:1.85-alpine", manifest.buildImages.rust],
      ["ubuntu:22.04", manifest.buildImages.ubuntu22],
      ["ubuntu:24.04", manifest.buildImages.ubuntu24],
      ["alpine:3.21", manifest.buildImages.alpine],
    ]);
    text = text.replace(
      /^FROM (\S+)(.*)$/gm,
      (_, image, rest) => `FROM ${pins.get(image) ?? image}${rest}`,
    );
    text = text.replace(
      "ARG CUBE_BUILD_TIME=unknown",
      "ARG CUBE_BUILD_TIME=unknown\nARG PI_CLOUD_GOPROXY=https://goproxy.cn|https://proxy.golang.org|direct\nENV GOPROXY=${PI_CLOUD_GOPROXY}",
    );
    text = text.replace(
      "cargo build --release -p cubecow",
      "cargo build --locked --release -p cubecow",
    );
    await writeFile(dockerfile, text);
    await access(`${original}.dockerignore`)
      .then(() => copyFile(`${original}.dockerignore`, `${dockerfile}.dockerignore`))
      .catch(() => {});
    await run("docker", [
      "build",
      "--network=host",
      "--build-arg",
      `CUBE_BUILDER_IMAGE=${manifest.buildImages.cubeletBuilder}`,
      "--build-arg",
      `CUBE_VERSION=0.6.0-picloud-${patchId}`,
      "--build-arg",
      `CUBE_COMMIT=${manifest.upstreamCommit}+${patchId}`,
      ...(process.env.PI_CLOUD_GOPROXY
        ? ["--build-arg", `PI_CLOUD_GOPROXY=${process.env.PI_CLOUD_GOPROXY}`]
        : []),
      "-f",
      dockerfile,
      "-t",
      `pi-cloud/${name}:${tag}`,
      join(temporary, context),
    ]);
  }
  await run("docker", [
    "build",
    "--network=host",
    "--build-arg",
    `CUBELET_BASE_IMAGE=pi-cloud/cubelet-base:${tag}`,
    "-f",
    "deploy/cubesandbox/Dockerfile.cubelet",
    "-t",
    `pi-cloud/cubelet:${tag}`,
    ".",
  ]);
  process.stdout.write(`Cube managed runtime images built: ${tag}; patch set ${patchId}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
