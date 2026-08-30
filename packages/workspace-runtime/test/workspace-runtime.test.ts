import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceSeed,
  createWorkspaceVolumeSettlement,
  decodeWorkspaceBlob,
  encodeWorkspaceBlob,
  createWorkspaceSeed,
  mergeWorkspaceSeeds,
  parseWorkspaceSeed,
  parseWorkspaceVolumeSettlement,
  restoreWorkspaceSeed,
  workspaceSeedMetadata,
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
  it("round-trips user-owned Git metadata in a bounded snapshot envelope", async () => {
    const source = await temporaryDirectory("pi-cloud-workspace-runtime-source-");
    await mkdir(resolve(source, ".git"));
    await writeFile(resolve(source, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(resolve(source, ".pi-cloud-home"));
    await writeFile(resolve(source, ".pi-cloud-home/.git-credentials"), "source-secret\n");
    await mkdir(resolve(source, "src"));
    await writeFile(resolve(source, "src/App.java"), "class App {}\n");
    await writeFile(resolve(source, "test.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(resolve(source, "test.sh"), 0o755);

    const snapshot = await captureWorkspaceSeed(source);
    const restoredEnvelope = decodeWorkspaceBlob(encodeWorkspaceBlob(snapshot));
    expect(Buffer.from(restoredEnvelope)).toEqual(Buffer.from(snapshot));

    const target = await temporaryDirectory("pi-cloud-workspace-runtime-target-");
    await mkdir(resolve(target, ".pi-cloud-home"));
    await writeFile(resolve(target, ".pi-cloud-home/.git-credentials"), "target-secret\n");
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSeed(target, restoredEnvelope);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "ref: refs/heads/main\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(
      readFile(resolve(target, ".pi-cloud-home/.git-credentials"), "utf8"),
    ).resolves.toBe("target-secret\n");
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
  });

  it("merges exact repository snapshots beneath disjoint normalized roots", () => {
    const merged = mergeWorkspaceSeeds([
      {
        root: "frontend",
        seed: createWorkspaceSeed([
          { path: "package.json", executable: false, content: Buffer.from("{}\n") },
        ]),
      },
      {
        root: "shared-lib",
        seed: createWorkspaceSeed([
          {
            path: "src/Library.java",
            executable: false,
            content: Buffer.from("class Library {}\n"),
          },
        ]),
      },
    ]);
    expect(parseWorkspaceSeed(merged).map((file) => file.path)).toEqual([
      "frontend/package.json",
      "shared-lib/src/Library.java",
    ]);
    expect(() =>
      mergeWorkspaceSeeds([
        { root: "frontend", seed: createWorkspaceSeed([]) },
        { root: "frontend", seed: createWorkspaceSeed([]) },
      ]),
    ).toThrow(/root/);
    expect(() =>
      mergeWorkspaceSeeds([
        { root: ".", seed: createWorkspaceSeed([]) },
        { root: "backend", seed: createWorkspaceSeed([]) },
      ]),
    ).toThrow(/root/);
  });

  it("round-trips a lightweight Workspace Volume settlement without indexing files", () => {
    const settlement = createWorkspaceVolumeSettlement({
      volumeId: `pcw-${"a".repeat(48)}`,
      settlementRevision: "f".repeat(64),
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-volume",
      workspaceId: "workspace-volume",
      sourceSessionId: "session-volume",
      bindingSha256: "b".repeat(64),
      fencingToken: 9,
      imageRevision: "development",
      environmentSpecSha256: "c".repeat(64),
      recipeCommands: [],
    });
    expect(parseWorkspaceVolumeSettlement(settlement)).toMatchObject({
      settlementRevision: "f".repeat(64),
      tenantId: "tenant-volume",
      workspaceId: "workspace-volume",
      sourceSessionId: "session-volume",
      fencingToken: 9,
    });
    expect(workspaceSeedMetadata(settlement)).toEqual([]);
    expect(() => parseWorkspaceSeed(settlement)).toThrow(/portable file bytes/);

    const withUnexpectedField = JSON.parse(Buffer.from(settlement).toString("utf8")) as Record<
      string,
      unknown
    >;
    withUnexpectedField.untrusted = true;
    expect(
      parseWorkspaceVolumeSettlement(Buffer.from(JSON.stringify(withUnexpectedField))),
    ).toBeUndefined();

    const previousLayout = {
      ...(JSON.parse(Buffer.from(settlement).toString("utf8")) as Record<string, unknown>),
      format: "pi-cloud.workspace-volume-reference.v0",
    };
    expect(
      parseWorkspaceVolumeSettlement(Buffer.from(JSON.stringify(previousLayout))),
    ).toBeUndefined();
  });
});
