import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { executeNativeTool } from "../../../packages/tool-sandbox/src/native-tools.ts";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  parseToolWorkerInput,
} from "../../../packages/protocol/src/index.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-guest-review-"));
const manifest = JSON.parse(await readFile(join(root, "deploy/cubesandbox/runtime-build.json")));
const report = {
  reviewedRevision: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
  checkedAt: new Date().toISOString(),
  piVersion: "1.0.0",
  cubeCommit: manifest.upstreamCommit,
  liveVmFaultInjection: false,
  productionMutations: false,
  paths: [],
};
const operation = (toolName, args) => ({
  toolBrokerProtocolVersion: 1,
  type: "tool_sandbox.operation",
  operation: "tool.execute",
  activationId: randomUUID(),
  operationId: randomUUID(),
  toolCallId: "review-call",
  toolName,
  args,
  timeoutMs: 1000,
  maximumOutputBytes: 51200,
});
try {
  for (const sample of [
    { name: "leading-at", file: "sample.txt", path: "@sample.txt" },
    { name: "unicode-space", file: "my file.txt", path: "my\u00a0file.txt" },
    { name: "decomposed-unicode", file: "cafe\u0301.txt", path: "caf\u00e9.txt" },
    { name: "curly-apostrophe", file: "it\u2019s.txt", path: "it's.txt" },
    { name: "literal-at-collision", file: "target.txt", path: "@target.txt", collision: true },
  ]) {
    await writeFile(join(temporary, sample.file), "EXPECTED\n");
    if (sample.collision) await writeFile(join(temporary, sample.path), "DIFFERENT\n");
    const native = await createReadTool().execute(
      { path: sample.path },
      { env: new NodeExecutionEnv({ cwd: temporary }), diagnostic() {} },
      BACKGROUND_CONTEXT,
    );
    const cloud = await executeNativeTool(
      operation("read", { path: sample.path }),
      temporary,
      new AbortController().signal,
      () => {},
    );
    assert.equal(native.content[0].text, "EXPECTED\n");
    assert.equal(cloud.isError, !sample.collision);
    if (sample.collision) assert.equal(cloud.result.content[0].text, "DIFFERENT\n");
    report.paths.push({
      case: sample.name,
      nativeReadsExpectedFile: true,
      cloudIsError: cloud.isError,
      cloudReadsDifferentFile: !!sample.collision,
    });
  }
  const written = await executeNativeTool(
    operation("write", { path: "@created.txt", content: "CREATED" }),
    temporary,
    new AbortController().signal,
    () => {},
  );
  assert.equal(written.isError, false);
  assert.equal(await readFile(join(temporary, "created.txt"), "utf8"), "CREATED");
  const reread = await executeNativeTool(
    operation("read", { path: "@created.txt" }),
    temporary,
    new AbortController().signal,
    () => {},
  );
  assert.equal(reread.isError, true);
  report.writeThenReadSamePath = { writeSucceeded: true, readFailed: true };

  const initialization = parseToolWorkerInput({
    toolWorkerProtocolVersion: 5,
    type: "worker.initialize",
    activationId: randomUUID(),
    toolRoot: "/workspace",
    environment: {
      environmentVersionId: randomUUID(),
      versionNumber: 1,
      profileKey: "pi-cloud-fullstack",
      profileVersion: "1",
      imageRevision: "review-pinned-guest",
      specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
    workspaceSeed: { kind: "sample_java" },
    webProxy: { host: "10.255.255.254", port: 3128 },
  });
  report.attachment = {
    fixture: "code-owned default environment",
    initializationBytes: Buffer.byteLength(JSON.stringify(initialization)),
    consumedFieldBytes: Buffer.byteLength(
      JSON.stringify({
        activationId: initialization.activationId,
        toolRoot: initialization.toolRoot,
        webProxy: initialization.webProxy,
      }),
    ),
    unusedOperationFields: ["environment", "workspaceSeed"],
    proposedWireSizeOrProductionLatencyNotMeasured: true,
  };

  const repository = process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox");
  await exec("git", [
    "-C",
    repository,
    "archive",
    "--format=tar",
    `--output=${temporary}/cube.tar`,
    manifest.upstreamCommit,
  ]);
  const cube = join(temporary, "cube");
  await exec("mkdir", [cube]);
  await exec("tar", ["-xf", join(temporary, "cube.tar"), "-C", cube]);
  for (const patch of manifest.patches) {
    const path = join(root, "deploy/cubesandbox/patches", patch.file);
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      patch.sha256,
    );
    await exec("git", ["apply", path], { cwd: cube });
  }
  await copyFile(
    new URL("./native_boundaries_test.go", import.meta.url),
    join(cube, "Cubelet/pkg/execution/review_boundaries_test.go"),
  );
  const options = {
    cwd: join(cube, "Cubelet"),
    timeout: 240000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      GOPROXY: process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct",
    },
  };
  report.goVersion = (await exec("go", ["version"], options)).stdout.trim();
  await exec(
    "go",
    ["test", "-race", "-skip", "^TestReview", "-count=1", "./pkg/execution"],
    options,
  );
  report.nativeExecutionBaselinePassed = true;
  const probe = await exec(
    "go",
    ["test", "-race", "-run", "^TestReview", "-count=1", "-v", "./pkg/execution"],
    options,
  );
  report.nativeProbes = probe.stdout
    .split("\n")
    .filter((line) => line.includes("MEASUREMENT "))
    .map((line) => JSON.parse(line.split("MEASUREMENT ")[1]));
  assert.equal(report.nativeProbes.length, 2);
  report.sourceSha256 = {};
  for (const path of [
    "deploy/cubesandbox/runtime-build.json",
    "packages/tool-sandbox/src/native-tools.ts",
    "packages/tool-sandbox/src/envd-tool-exec.ts",
    "packages/tool-sandbox/src/cube-tool-scope.ts",
    "packages/tool-sandbox/src/execution-cgroup.ts",
    "packages/tool-sandbox/src/tool-worker.ts",
  ])
    report.sourceSha256[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  const output = resolve(process.argv[2] ?? "/tmp/pi-cloud-guest-review-results.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
