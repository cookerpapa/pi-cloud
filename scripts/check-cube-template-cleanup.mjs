import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const images = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/test-images.json"), "utf8"),
);
const source = process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox");
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-template-check-"));
const exec = promisify(execFile);
const run = (command, args, env = process.env) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${command} exited ${code}`)),
    );
  });
let mysql;
try {
  await exec("git", [
    "-C",
    source,
    "archive",
    "--format=tar",
    `--output=${directory}/source.tar`,
    manifest.upstreamCommit,
  ]);
  await exec("tar", ["-xf", `${directory}/source.tar`, "-C", directory]);
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== patch.sha256
    )
      throw new Error(`Cube patch digest changed: ${patch.file}`);
    await exec("git", ["apply", path], { cwd: directory });
  }
  const name = `pi-cloud-template-mysql-${process.pid}`;
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
    "-e",
    "MYSQL_DATABASE=template_cleanup_test",
    "-p",
    "127.0.0.1::3306",
    images.mysql,
  ]);
  mysql = name;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await exec("docker", [
        "exec",
        name,
        "mysql",
        "--protocol=TCP",
        "-h127.0.0.1",
        "-uroot",
        "template_cleanup_test",
        "-e",
        "select 1",
      ]);
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  if (!ready) throw new Error("Disposable template MySQL failed to start");
  const info = JSON.parse((await exec("docker", ["inspect", name])).stdout)[0];
  const port = info.NetworkSettings.Ports["3306/tcp"][0].HostPort;
  const dsn = `root@tcp(127.0.0.1:${port})/template_cleanup_test?parseTime=true&multiStatements=true`;
  await run(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--memory=4g",
      "--cpus=4",
      "-v",
      `${directory}:/source:ro`,
      "-w",
      "/source/CubeMaster",
      ...(process.env.PI_CLOUD_GO_CACHE_DIRECTORY
        ? [
            "-v",
            `${resolve(process.env.PI_CLOUD_GO_CACHE_DIRECTORY)}:/go`,
            "-e",
            "GOCACHE=/go/cache",
            "--user",
            `${process.getuid()}:${process.getgid()}`,
          ]
        : []),
      "-e",
      `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
      "-e",
      "PI_CLOUD_TEMPLATE_CLEANUP_MYSQL_DSN",
      ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
        .filter((k) => process.env[k])
        .flatMap((k) => ["-e", k]),
      manifest.buildImages.go,
      "go",
      "test",
      "-mod=readonly",
      "-gcflags=all=-l",
      "-v",
      "./pkg/templatecenter",
    ],
    { ...process.env, PI_CLOUD_TEMPLATE_CLEANUP_MYSQL_DSN: dsn },
  );
  process.stdout.write("cube_template_cleanup_contract_passed\n");
} finally {
  if (mysql) await exec("docker", ["rm", "-f", mysql]);
  await rm(directory, { recursive: true, force: true });
}
