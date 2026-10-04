// Run the review-only receipt-loss characterizations against the pinned native source.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, copyFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const dir = await mkdtemp(join(tmpdir(), "pi-cloud-review-receipts-"));
const exec = promisify(execFile),
  name = "pi-cloud-review-" + randomUUID();
let container;
try {
  await exec("git", [
    "-C",
    process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
    "archive",
    "--format=tar",
    `--output=${join(dir, "source.tar")}`,
    manifest.upstreamCommit,
  ]);
  await exec("tar", ["-xf", join(dir, "source.tar"), "-C", dir]);
  for (const p of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", p.file);
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== p.sha256
    )
      throw Error("Native patch changed");
    await exec("git", ["apply", path], { cwd: dir });
  }
  for (const [component, file] of [
    ["Cubelet", "node_receipt_test.go"],
    ["CubeMaster", "master_receipt_test.go"],
  ])
    await copyFile(
      join(root, "scripts/review-20261004-cube", file),
      join(dir, component, "pkg/allocation/review_receipt_test.go"),
    );
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
      manifest.testImages.mysql,
    ]);
    container = name;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await exec("docker", ["exec", name, "mysqladmin", "ping", "--silent"]);
        ready = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    if (!ready) throw Error("Review MySQL did not start");
    const v = JSON.parse((await exec("docker", ["inspect", name])).stdout)[0];
    dsn = `root@tcp(127.0.0.1:${v.NetworkSettings.Ports["3306/tcp"][0].HostPort})/allocation_test?parseTime=true&multiStatements=true`;
  }
  for (const component of ["Cubelet", "CubeMaster"]) {
    const r = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "--memory=1g",
        "--cpus=2",
        "-v",
        `${dir}:/source:ro`,
        "-w",
        `/source/${component}`,
        "-e",
        "PI_CLOUD_ALLOCATION_MYSQL_DSN",
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
        "-race",
        "-run",
        "TestReview",
        "-v",
        "./pkg/allocation",
      ],
      {
        env: { ...process.env, PI_CLOUD_ALLOCATION_MYSQL_DSN: dsn },
        timeout: 300000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    process.stdout.write(r.stdout);
    if (r.stdout.includes("--- SKIP")) throw Error("Required native review test was skipped");
  }
} finally {
  if (container) await exec("docker", ["stop", "-t", "5", container]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
