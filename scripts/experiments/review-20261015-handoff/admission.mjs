import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(root, "deploy/cubesandbox/runtime-build.json"), "utf8"),
);
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-handoff-admission-probe-"));
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
      throw Error(`Changed patch: ${patch.file}`);
    await exec(
      "git",
      ["apply", ...files.map((f) => `--include=Cubelet/pkg/execution/${f}`), path],
      { cwd: directory },
    );
  }
  const cwd = join(directory, "Cubelet/pkg/execution");
  await copyFile(new URL("admission_test.go", import.meta.url), join(cwd, "review_test.go"));
  await writeFile(
    join(cwd, "go.mod"),
    "module cubeadmissioncontract\n\ngo 1.24.0\n\nrequire github.com/google/uuid v1.6.0\n",
  );
  await writeFile(
    join(cwd, "go.sum"),
    "github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\ngithub.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=\n",
  );
  const { stdout } = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--env",
      "GOPROXY=https://goproxy.cn|https://proxy.golang.org|direct",
      ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
        .filter((k) => process.env[k])
        .flatMap((k) => ["--env", k]),
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
      "-run",
      "^TestReview",
      "./...",
    ],
    { timeout: 180000 },
  );
  const cases = stdout
    .split("\n")
    .filter((l) => l.startsWith("REVIEW_EVIDENCE "))
    .map((l) => JSON.parse(l.slice(16)));
  if (cases.length !== 2) throw Error("Missing audit evidence");
  const result = { baseline: "93635d37", upstream: manifest.upstreamCommit, cases };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-handoff-review-admission.json",
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(stdout);
} finally {
  await rm(directory, { recursive: true, force: true });
}
