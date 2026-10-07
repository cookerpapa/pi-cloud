import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  symlink,
  unlink,
  rm,
  cp,
  readFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { guestBuildIdentity, guestCopyInputs } from "./guest-build-identity.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { build } from "esbuild";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const repository = fileURLToPath(new URL("../..", import.meta.url));

it("bundles the real guest using only declared COPY inputs, without model/API modules", async () => {
  const copied = guestCopyInputs(
    await readFile(join(repository, "deploy/cubesandbox/Dockerfile.tool"), "utf8"),
  );
  const bundle = await build({
    absWorkingDir: repository,
    entryPoints: [
      "packages/tool-sandbox/src/envd-tool-exec.ts",
      "packages/tool-sandbox/src/envd-guest-control.ts",
    ],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["sharp"],
    outdir: "unused-guest-test-output",
    logLevel: "silent",
  });
  const inputs = Object.keys(bundle.metafile.inputs).filter((path) => path.startsWith("packages/"));
  for (const input of inputs)
    expect(
      copied.some((path) => input === path || input.startsWith(path + "/")),
      input,
    ).toBe(true);
  expect(inputs).not.toContain("packages/protocol/src/index.ts");
  expect(inputs).not.toContain("packages/protocol/src/model-catalog.ts");
  expect(inputs).not.toContain("packages/protocol/src/control-plane-api.ts");
  expect(inputs.some((path) => path.startsWith("packages/sandbox-supervisor/"))).toBe(false);
  expect(
    Object.keys(bundle.metafile.inputs).some((path) =>
      /node_modules\/(?:@earendil-works\/pi-(?:coding-agent|ai|mcp|codemode|tui)|openai|@anthropic-ai\/sdk|@google\/genai)\//.test(
        path,
      ),
    ),
  ).toBe(false);
});

it("the actual guest identity ignores model edits but includes copied protocol and Tool changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-guest-closure-"));
  try {
    const copied = guestCopyInputs(
      await readFile(join(repository, "deploy/cubesandbox/Dockerfile.tool"), "utf8"),
    );
    for (const input of copied) {
      const target = join(root, input);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(repository, input), target, { recursive: true });
    }
    const original = await guestBuildIdentity(root);
    await writeFile(
      join(root, "packages/protocol/src/model-catalog.ts"),
      "// an unrelated model change\n",
    );
    expect(await guestBuildIdentity(root)).toBe(original);
    await appendFile(
      join(root, "packages/protocol/src/environment.ts"),
      "\n// a guest dependency change\n",
    );
    const changed = await guestBuildIdentity(root);
    expect(changed).not.toBe(original);
    await appendFile(
      join(root, "packages/tool-sandbox/src/image-processor.ts"),
      "\n// a guest Tool change\n",
    );
    expect(await guestBuildIdentity(root)).not.toBe(changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("includes explicit guest inputs, modes and links while ignoring unrelated UI/docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-guest-build-"));
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "deploy/cubesandbox/Dockerfile.tool"),
      "FROM example@sha256:fixture\nCOPY src /app\nCOPY --from=builder /out /bin\n",
    );
    await writeFile(join(root, "src/tool.sh"), "echo fixture\n", { mode: 0o644 });
    const first = await guestBuildIdentity(root);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(root, "README.md"), "unrelated docs");
    await writeFile(join(root, "frontend.ts"), "unrelated UI");
    expect(await guestBuildIdentity(root)).toBe(first);
    await chmod(join(root, "src/tool.sh"), 0o755);
    expect(await guestBuildIdentity(root)).not.toBe(first);
    await chmod(join(root, "src/tool.sh"), 0o644);
    await writeFile(join(root, "src/tool.sh"), "echo changed\n");
    expect(await guestBuildIdentity(root)).not.toBe(first);
    await symlink("tool.sh", join(root, "src/link"));
    const linked = await guestBuildIdentity(root);
    await unlink(join(root, "src/link"));
    await symlink("../README.md", join(root, "src/link"));
    expect(await guestBuildIdentity(root)).not.toBe(linked);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recognizes multi-line COPY and rejects implicit build-context scans", () => {
  expect(guestCopyInputs("COPY --chown=1000:1000 \\\n  a b \\\n  /destination\n")).toEqual([
    "a",
    "b",
    "deploy/cubesandbox/Dockerfile.tool",
  ]);
  expect(() => guestCopyInputs("COPY . /app")).toThrow("explicit local inputs");
  expect(() => guestCopyInputs("COPY src/* /app")).toThrow("explicit local inputs");
});

it("reconstructs Git source independently of a private caller umask without changing checkout modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-guest-archive-"));
  const originalUmask = process.umask();
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "deploy/cubesandbox/Dockerfile.tool"),
      "FROM fixture\nCOPY src /app\n",
    );
    await writeFile(join(root, "src/run.sh"), "#!/bin/sh\necho fixture\n");
    await writeFile(join(root, "src/data"), "fixture\n");
    // The source tree has normal Git checkout permissions, including an
    // executable and a link. The private temp parent remains private.
    for (const path of ["deploy", "deploy/cubesandbox", "src", "src/run.sh"])
      await chmod(join(root, path), 0o755);
    for (const path of ["deploy/cubesandbox/Dockerfile.tool", "src/data"])
      await chmod(join(root, path), 0o644);
    await symlink("run.sh", join(root, "src/link"));
    await execFile("git", ["init", "--quiet", root]);
    await execFile("git", ["-C", root, "add", "."]);
    await execFile("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const revision = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const expected = await guestBuildIdentity(root);
    const moduleUrl = new URL("./guest-build-identity.mjs", import.meta.url).href;
    for (const mask of ["022", "077"]) {
      const { stdout } = await execFile(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import { guestBuildIdentityAtRevision } from ${JSON.stringify(moduleUrl)};
        process.umask(parseInt(process.argv[3], 8));
        const before = process.umask();
        const identity = await guestBuildIdentityAtRevision(process.argv[1], process.argv[2]);
        if (process.umask() !== before) throw new Error("caller umask changed");
        process.stdout.write(identity);
      `,
        root,
        revision,
        mask,
      ]);
      expect(stdout).toBe(expected);
    }
    expect(process.umask()).toBe(originalUmask);
    expect(await guestBuildIdentity(root)).toBe(expected);
    const { guestBuildIdentityAtRevision } = await import("./guest-build-identity.mjs");
    await expect(guestBuildIdentityAtRevision(root, "0".repeat(40))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("changes the completion identity when its protocol or pinned native runtime changes", async () => {
  const { completionBuildIdentity } = await import("./guest-build-identity.mjs");
  const root = await mkdtemp(join(tmpdir(), "pi-completion-identity-"));
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await writeFile(
      join(root, "deploy/cubesandbox/Dockerfile.cubelet"),
      "FROM fixture\nCOPY protocol.ts /opt/protocol.ts\n",
    );
    await writeFile(
      join(root, "deploy/cubesandbox/runtime-build.json"),
      '{"upstreamCommit":"first"}',
    );
    await writeFile(join(root, "protocol.ts"), "budget: number");
    const before = await completionBuildIdentity(root);
    await writeFile(
      join(root, "deploy/cubesandbox/test-images.json"),
      JSON.stringify({ mysql: "changed-test-only-image" }),
    );
    expect(await completionBuildIdentity(root)).toBe(before);
    await writeFile(join(root, "protocol.ts"), "budget: number | null");
    const nullable = await completionBuildIdentity(root);
    expect(nullable).not.toBe(before);
    await writeFile(
      join(root, "deploy/cubesandbox/runtime-build.json"),
      '{"upstreamCommit":"second"}',
    );
    expect(await completionBuildIdentity(root)).not.toBe(nullable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps database migrations outside the real completion image identity", async () => {
  const { completionBuildIdentity } = await import("./guest-build-identity.mjs");
  const root = await mkdtemp(join(tmpdir(), "pi-completion-scope-"));
  try {
    const copied = guestCopyInputs(
      await readFile(join(repository, "deploy/cubesandbox/Dockerfile.cubelet"), "utf8"),
      "deploy/cubesandbox/Dockerfile.cubelet",
    );
    for (const input of [...copied, "deploy/cubesandbox/runtime-build.json"]) {
      const target = join(root, input);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(repository, input), target, { recursive: true });
    }
    const before = await completionBuildIdentity(root);
    await mkdir(join(root, "packages/database/src/migrations"), { recursive: true });
    await writeFile(
      join(root, "packages/database/src/migrations/unrelated.ts"),
      "throw new Error('not completion code');",
    );
    expect(await completionBuildIdentity(root)).toBe(before);
    await appendFile(
      join(root, "packages/database/src/client.ts"),
      "\n// transport adapter change\n",
    );
    expect(await completionBuildIdentity(root)).not.toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
