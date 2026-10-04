// Run the maintained destination admission tests directly from the pinned patch,
// without an operator checkout, VM, or a second copy of the implementation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-cube-admission-"));
try {
  await exec("git", ["init", "--quiet"], { cwd: directory });
  const files = [
    "manager.go",
    "probe.go",
    "manager_test.go",
    "probe_test.go",
    "ordered_admission_test.go",
    "terminal_input.go",
    "terminal_input_test.go",
  ];
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== patch.sha256
    )
      throw new Error(`Cube patch digest changed: ${patch.file}`);
    await exec(
      "git",
      ["apply", ...files.map((f) => `--include=Cubelet/pkg/execution/${f}`), path],
      { cwd: directory },
    );
  }
  const cwd = join(directory, "Cubelet/pkg/execution");
  await writeFile(
    join(cwd, "go.mod"),
    "module cubeadmissioncontract\n\ngo 1.24.0\n\nrequire github.com/google/uuid v1.6.0\n",
  );
  await writeFile(
    join(cwd, "go.sum"),
    "github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\ngithub.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=\n",
  );
  const result = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--env",
      `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
      ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
        .filter((name) => process.env[name])
        .flatMap((name) => ["--env", name]),
      "--memory=768m",
      "--cpus=2",
      "-v",
      `${cwd}:/contract:ro`,
      "-w",
      "/contract",
      manifest.buildImages.go,
      "go",
      "test",
      "-mod=readonly",
      "-race",
      "-v",
      "./...",
    ],
    { timeout: 180000 },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await rm(directory, { recursive: true, force: true });
}
