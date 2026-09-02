import { createWorkspaceSeed, restoreWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded Workspace seed bundle", () => {
  it("round-trips user-owned Git metadata with regular files and executable bits", async () => {
    const snapshot = createWorkspaceSeed([
      {
        path: ".git/HEAD",
        executable: false,
        content: Buffer.from("ref: refs/heads/main\n"),
      },
      {
        path: "src/App.java",
        executable: false,
        content: Buffer.from("class App {}\n"),
      },
      { path: "test.sh", executable: true, content: Buffer.from("#!/bin/sh\nexit 0\n") },
    ]);

    const target = await temporaryDirectory("pi-cloud-workspace-target-");
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSeed(target, snapshot);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "ref: refs/heads/main\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
  });

  it("validates every path before mutating the destination", async () => {
    const malicious = Buffer.from(
      `${JSON.stringify({
        format: "pi-cloud.workspace-seed.v1",
        files: [
          {
            path: "../escape",
            executable: false,
            sizeBytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            content: "",
          },
        ],
      })}\n`,
    );
    const target = await temporaryDirectory("pi-cloud-workspace-reject-");
    await writeFile(resolve(target, "keep.txt"), "still here");
    await expect(restoreWorkspaceSeed(target, malicious)).rejects.toThrow(/entry|path/i);
    await expect(readFile(resolve(target, "keep.txt"), "utf8")).resolves.toBe("still here");
  });
});
