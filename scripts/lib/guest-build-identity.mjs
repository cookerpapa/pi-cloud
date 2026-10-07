import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { lstat, readFile, readdir, readlink, realpath, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";

const guestDockerfile = "deploy/cubesandbox/Dockerfile.tool";

export function guestCopyInputs(dockerfile, dockerfilePath = guestDockerfile) {
  const inputs = new Set([dockerfilePath]);
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (!/^COPY\s/i.test(line.trim()) || /\s--from(?:=|\s)/i.test(line)) continue;
    const tokens = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .filter((token) => !token.startsWith("--"));
    if (tokens.length < 2) throw new Error("Guest COPY must name explicit local inputs");
    for (const input of tokens.slice(0, -1)) {
      if (
        input === "." ||
        isAbsolute(input) ||
        input.split("/").includes("..") ||
        /[\[\]"'$*?]/.test(input)
      )
        throw new Error("Guest COPY must name explicit local inputs");
      inputs.add(input);
    }
  }
  return [...inputs].sort();
}

/** Runtime identity only; the actual built image still has its full OCI digest. */
export function guestBuildIdentity(repositoryRoot) {
  return buildIdentity(repositoryRoot, guestDockerfile, "pi-cloud.guest-build-inputs.v1\0");
}

/** Reproduce the declared source inputs without changing the working checkout.
 * Missing source commits are an evidence error, never permission to trust a tag. */
export async function guestBuildIdentityAtRevision(repositoryRoot, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Guest source revision must be a full SHA");
  const run = promisify(execFile),
    directory = await mkdtemp(join(tmpdir(), "pi-cloud-guest-source-"));
  try {
    const archive = join(directory, "source.tar");
    await run(
      "git",
      ["-C", repositoryRoot, "archive", "--format=tar", `--output=${archive}`, revision],
      { timeout: 30_000 },
    );
    await run("tar", ["-xf", archive, "-C", directory], { timeout: 30_000 });
    return await guestBuildIdentity(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function completionBuildIdentity(repositoryRoot) {
  return buildIdentity(
    repositoryRoot,
    "deploy/cubesandbox/Dockerfile.cubelet",
    "pi-cloud.completion-build-inputs.v1\0",
    ["deploy/cubesandbox/runtime-build.json"],
  );
}

async function buildIdentity(repositoryRoot, dockerfilePath, prefix, extraInputs = []) {
  const root = resolve(repositoryRoot);
  const dockerfile = await readFile(resolve(root, dockerfilePath), "utf8");
  const hash = createHash("sha256").update(prefix);
  const active = new Set();
  async function visit(path) {
    const addressed = resolve(path),
      name = relative(root, addressed).split(sep).join("/");
    if (name === ".." || name.startsWith("../") || isAbsolute(name))
      throw new Error("Guest build input leaves its repository");
    if (active.has(addressed)) throw new Error("Guest build input contains a link cycle");
    active.add(addressed);
    try {
      const info = await lstat(addressed);
      if (info.isDirectory()) {
        hash.update(JSON.stringify([name, "directory", info.mode & 0o777]));
        for (const child of (await readdir(addressed)).sort())
          await visit(resolve(addressed, child));
      } else if (info.isSymbolicLink()) {
        hash.update(JSON.stringify([name, "symlink", await readlink(addressed)]));
        await visit(await realpath(addressed));
      } else if (info.isFile()) {
        const bytes = await readFile(addressed);
        hash.update(JSON.stringify([name, "file", info.mode & 0o777, bytes.length])).update(bytes);
      } else throw new Error("Guest build input is not a regular file, directory or link");
    } finally {
      active.delete(addressed);
    }
  }
  for (const input of [...guestCopyInputs(dockerfile, dockerfilePath), ...extraInputs])
    await visit(resolve(root, input));
  return hash.digest("hex").slice(0, 40);
}
