import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const { stdout } = await execute("git", ["ls-files", "-z"], { cwd: root });
const tracked = stdout.split("\0").filter(Boolean);
const dockerfiles = tracked.filter((path) => /(^|\/)Dockerfile(?:\.[^/]+)?$/u.test(path));
const required = new Set();
for (const path of dockerfiles) {
  const content = (await readFile(resolve(root, path), "utf8")).replace(/\\\r?\n\s*/gu, " ");
  for (const line of content.split("\n")) {
    if (!line.startsWith("COPY ") || /--from=/u.test(line)) continue;
    const tokens = line
      .slice(5)
      .split(/\s+/u)
      .filter((token) => !token.startsWith("--"));
    for (const source of tokens.slice(0, -1)) {
      const paths = tracked.filter((file) => file === source || file.startsWith(`${source}/`));
      assert(paths.length > 0, `${path}: COPY source is not tracked: ${source}`);
      for (const file of paths) required.add(file);
    }
  }
}

const excluded = [
  ".env",
  ".git/config",
  "node_modules/context-canary.txt",
  "scripts/.env.local",
  "scripts/context-canary.log",
  "packages/control-plane/.env",
  "packages/control-plane/node_modules/context-canary.txt",
  "packages/web-ui/dist/context-canary.js",
  "packages/tool-broker/.cache/context-canary.txt",
  "packages/tool-broker/src/.env.local",
  "deploy/production/.env",
  "deploy/production/runtime/secrets/context-canary.txt",
  "deploy/cubesandbox/runtime/context-canary.txt",
  "deploy/gitlab/runtime/context-canary.txt",
];
const directory = await mkdtemp(resolve(tmpdir(), "pi-cloud-build-context-"));
try {
  const context = resolve(directory, "input");
  const output = resolve(directory, "output");
  // Never send the real deployment directory or credentials to this probe.
  // Every COPY input and excluded file contains only the same harmless marker.
  for (const path of new Set([...required, ...excluded])) {
    const target = resolve(context, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "pi-cloud build-context fixture\n");
  }
  await writeFile(
    resolve(context, ".dockerignore"),
    await readFile(resolve(root, ".dockerignore")),
  );
  await writeFile(resolve(context, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  await execute(
    "docker",
    ["build", "--network=none", "--output", `type=local,dest=${output}`, context],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const leaked = [];
  for (const path of excluded) {
    try {
      await access(resolve(output, path));
      leaked.push(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert.deepEqual(leaked, [], "Private/generated paths must not enter the build context");
  for (const path of required) {
    await assert.doesNotReject(
      access(resolve(output, path)),
      `Build context lost COPY input ${path}`,
    );
  }
  console.log(
    `docker_build_context_ok dockerfiles=${dockerfiles.length} inputs=${required.size} excluded=${excluded.length}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
