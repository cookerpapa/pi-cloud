import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeWorkspaceBlob,
  encodeWorkspaceBlob,
  createWorkspaceSeed,
  initializeWorkspaceSeed,
} from "../src/index.ts";

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

describe("shared workspace runtime", () => {
  it("keeps user bytes and permissions through empty, repeated and concurrent initialization", async () => {
    const target = await temporaryDirectory("pi-cloud-seed-concurrent-");
    await writeFile(resolve(target, "owned.txt"), "user owns this");
    await chmod(resolve(target, "owned.txt"), 0o600);
    await initializeWorkspaceSeed(target, createWorkspaceSeed([]));
    const contents = ["a".repeat(200_000), "b".repeat(200_000)];
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        initializeWorkspaceSeed(
          target,
          createWorkspaceSeed([
            { path: "owned.txt", executable: true, content: Buffer.from("must not replace") },
            { path: "new.txt", executable: false, content: Buffer.from(contents[index % 2]!) },
          ]),
        ),
      ),
    );
    expect(await readFile(resolve(target, "owned.txt"), "utf8")).toBe("user owns this");
    expect((await stat(resolve(target, "owned.txt"))).mode & 0o777).toBe(0o600);
    expect(contents).toContain(await readFile(resolve(target, "new.txt"), "utf8"));
    expect((await readdir(target)).sort()).toEqual(["new.txt", "owned.txt"]);
  });

  it("initializes only missing files without replacing user data or credentials", async () => {
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
    const restoredEnvelope = decodeWorkspaceBlob(encodeWorkspaceBlob(snapshot));
    expect(Buffer.from(restoredEnvelope)).toEqual(Buffer.from(snapshot));

    const target = await temporaryDirectory("pi-cloud-workspace-runtime-target-");
    await writeFile(resolve(target, ".git-credentials"), "target-secret\n");
    await writeFile(resolve(target, "stale.txt"), "keep me");
    await initializeWorkspaceSeed(target, restoredEnvelope);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "ref: refs/heads/main\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, ".git-credentials"), "utf8")).resolves.toBe(
      "target-secret\n",
    );
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).resolves.toBe("keep me");
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
  });
});
