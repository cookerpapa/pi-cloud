import {
  captureWorkspaceSeed,
  restoreWorkspaceSeed,
  validateWorkspacePayload,
} from "../src/index.ts";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    const source = await temporaryDirectory("pi-cloud-workspace-source-");
    await mkdir(resolve(source, ".git"));
    await writeFile(resolve(source, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(resolve(source, "src"));
    await writeFile(resolve(source, "src/App.java"), "class App {}\n");
    await writeFile(resolve(source, "test.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(resolve(source, "test.sh"), 0o755);

    const snapshot = await captureWorkspaceSeed(source);
    validateWorkspacePayload(snapshot);

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
