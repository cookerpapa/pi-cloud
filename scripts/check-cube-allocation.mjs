// Exercise the maintained allocation patch with real node metadata and MySQL.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const testImages = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/test-images.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const repository = resolve(
  process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
);
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-allocation-contract-"));
const exec = promisify(execFile);
const name = `pi-cloud-allocation-${randomUUID()}`;
let container;
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
  await new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} failed (${code})`)),
    );
  });
}
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
  let dsn = process.env.PI_CLOUD_ALLOCATION_MYSQL_DSN;
  if (!dsn) {
    await exec("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-e",
      "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
      "-e",
      "MYSQL_DATABASE=allocation_test",
      "-p",
      "127.0.0.1::3306",
      testImages.mysql,
    ]);
    container = name;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await exec("docker", ["exec", name, "mysqladmin", "ping", "--silent"]);
        ready = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    if (!ready) throw new Error("Disposable MySQL failed to start");
    const info = JSON.parse((await exec("docker", ["inspect", name])).stdout)[0];
    const port = info.NetworkSettings.Ports["3306/tcp"][0].HostPort;
    dsn = `root@tcp(127.0.0.1:${port})/allocation_test?parseTime=true&multiStatements=true`;
  }
  for (const component of ["Cubelet", "CubeMaster"]) {
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "--memory=1g",
        "--cpus=2",
        // Execute freshly written test plugins from tmpfs; overlay-backed
        // temporary scripts can transiently fail exec with ETXTBSY.
        "--tmpfs",
        "/test-tmp:exec,mode=1777",
        "-e",
        "TMPDIR=/test-tmp",
        "-e",
        "GOTMPDIR=/tmp",
        "-v",
        `${directory}:/source:ro`,
        "-v",
        `${join(root, "deploy/cubesandbox/cube-volume-picloud-posix.sh")}:/posix-plugin:ro`,
        "-e",
        "PI_CLOUD_POSIX_PLUGIN=/posix-plugin",
        "-w",
        `/source/${component}`,
        "-e",
        `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
        "-e",
        "PI_CLOUD_ALLOCATION_MYSQL_DSN",
        ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
          .filter((k) => process.env[k])
          .flatMap((k) => ["-e", k]),
        manifest.buildImages.go,
        "go",
        "test",
        "-mod=readonly",
        "-race",
        // Go 1.26 testing.TempDir prefers GOTMPDIR. Keep compiler work on disk,
        // but execute tests with their temporary plugin directory on tmpfs.
        "-exec",
        "env GOTMPDIR=/test-tmp",
        "-v",
        "./pkg/allocation",
        ...(component === "Cubelet" ? ["./plugins/volume/...", "./pkg/execution"] : []),
      ],
      { env: { ...process.env, PI_CLOUD_ALLOCATION_MYSQL_DSN: dsn } },
    );
  }
  // Compose managed cleanup, paused destruction and completion-process recovery.
  // The logic fixture needs no KVM or CGO cubecow library; production builds
  // separately compile the CGO runtime and live tests exercise actual VMs.
  await run("docker", [
    "run",
    "--rm",
    "--network=host",
    "--memory=2g",
    "--cpus=2",
    "-v",
    `${directory}:/source:ro`,
    "-w",
    "/source/Cubelet",
    "-e",
    "CGO_ENABLED=0",
    "-e",
    `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
    ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
      .filter((k) => process.env[k])
      .flatMap((k) => ["-e", k]),
    manifest.buildImages.go,
    "go",
    "test",
    "-mod=readonly",
    "-count=1",
    "./services/cubebox",
    "-run",
    "TestManagedCleanup|TestDestroyAuto|TestExecution|TestVolumeHolder",
  ]);
} finally {
  if (container) await exec("docker", ["stop", "-t", "5", container]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
