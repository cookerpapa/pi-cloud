import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

configureBuildProxy();
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
assert.equal(manifest.providerContractVersion, 1);
assert.equal(manifest.patches, undefined, "Stock runtime cannot apply patches");
assert.equal(manifest.buildImages, undefined, "Stock runtime cannot rewrite dependency toolchains");
const tag = process.env.PI_CLOUD_IMAGE_VERSION ?? "production";
assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const temporary = await mkdtemp(join(tmpdir(), "pma-stock-cube-"));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
const inspect = (reference) =>
  JSON.parse(
    execFileSync("docker", ["image", "inspect", reference], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 ** 2,
    }),
  )[0];
try {
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
      "Invalid official native image pin",
    );
    await run("docker", ["pull", "--platform", source.platform, source.reference]);
    const base = inspect(source.reference);
    assert.equal(base.Architecture, "amd64");
    // No RUN, COPY, package upgrade, dependency rewrite or engine source build.
    const dockerfile = join(temporary, "Dockerfile");
    await writeFile(dockerfile, `FROM ${source.reference}\n`);
    const image = `pi-cloud/${name}:${tag}`;
    await run("docker", [
      "build",
      "--platform",
      source.platform,
      "--pull=false",
      "--label",
      `org.opencontainers.image.revision=${revision}`,
      "--label",
      `org.opencontainers.image.version=${tag}`,
      "--label",
      `org.opencontainers.image.base.name=${source.reference}`,
      "--label",
      `org.opencontainers.image.base.digest=${source.reference.split("@")[1]}`,
      "--label",
      `io.pi-cloud.cube.upstream-commit=${manifest.upstreamCommit}`,
      "--label",
      "io.pi-cloud.cube.provider-contract=1",
      "-f",
      dockerfile,
      "-t",
      image,
      temporary,
    ]);
    const built = inspect(image);
    assert.deepEqual(
      built.RootFS.Layers,
      base.RootFS.Layers,
      "Native runtime filesystem differs from the official image",
    );
    assert.deepEqual(built.Config.Entrypoint, base.Config.Entrypoint);
    assert.deepEqual(built.Config.Cmd, base.Config.Cmd);
    process.stdout.write(`Stock Cube filesystem verified: ${name}\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
