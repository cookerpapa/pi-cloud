import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("resolves both packed branch refs and linked worktrees through Git", async () => {
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-git-head-"));
  const repository = join(root, "repository"),
    worktree = join(root, "worktree");
  const git = async (...args) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args])
    ).stdout.trim();
  try {
    await git("init", "--initial-branch=main", repository);
    await git(
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    );
    const head = await git("-C", repository, "rev-parse", "HEAD");
    await git("-C", repository, "pack-refs", "--all");
    await git("-C", repository, "worktree", "add", "--detach", worktree, head);
    const source = await readFile(
      new URL("../install-cubesandbox-k3s.mjs", import.meta.url),
      "utf8",
    );
    const declaration = source.match(/^async function repositoryHead\([^]*?^}/m)?.[0];
    expect(declaration).toBeTruthy();
    const readHead = runInNewContext(`(${declaration})`, {
      readFile,
      join,
      capture: async (binary, args) => (await exec(binary, args)).stdout.trim(),
    });
    await expect(readHead(repository)).resolves.toBe(head);
    await expect(readHead(worktree)).resolves.toBe(head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
