import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceSnapshot,
  captureWorkspaceIndex,
  createPersistentVolumeReference,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  createWorkspaceSnapshot,
  mergeWorkspaceSnapshots,
  parseWorkspaceSnapshot,
  parsePersistentVolumeReference,
  restoreWorkspaceSnapshot,
  workspaceSnapshotMetadata,
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

    const snapshot = await captureWorkspaceSnapshot(source);
    const restoredEnvelope = decodeWorkspaceSnapshotBlob(encodeWorkspaceSnapshotBlob(snapshot));
    expect(Buffer.from(restoredEnvelope)).toEqual(Buffer.from(snapshot));

    const target = await temporaryDirectory("pi-cloud-workspace-runtime-target-");
    await mkdir(resolve(target, ".pi-cloud-home"));
    await writeFile(resolve(target, ".pi-cloud-home/.git-credentials"), "target-secret\n");
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSnapshot(target, restoredEnvelope);

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
    const merged = mergeWorkspaceSnapshots([
      {
        root: "frontend",
        snapshot: createWorkspaceSnapshot([
          { path: "package.json", executable: false, content: Buffer.from("{}\n") },
        ]),
      },
      {
        root: "shared-lib",
        snapshot: createWorkspaceSnapshot([
          {
            path: "src/Library.java",
            executable: false,
            content: Buffer.from("class Library {}\n"),
          },
        ]),
      },
    ]);
    expect(parseWorkspaceSnapshot(merged).map((file) => file.path)).toEqual([
      "frontend/package.json",
      "shared-lib/src/Library.java",
    ]);
    expect(() =>
      mergeWorkspaceSnapshots([
        { root: "frontend", snapshot: createWorkspaceSnapshot([]) },
        { root: "frontend", snapshot: createWorkspaceSnapshot([]) },
      ]),
    ).toThrow(/root/);
    expect(() =>
      mergeWorkspaceSnapshots([
        { root: ".", snapshot: createWorkspaceSnapshot([]) },
        { root: "backend", snapshot: createWorkspaceSnapshot([]) },
      ]),
    ).toThrow(/root/);
  });

  it("indexes a large Workspace without embedding file bytes or dropping nested Git state", async () => {
    const root = await temporaryDirectory("pi-cloud-cube-workspace-index-");
    await mkdir(resolve(root, ".git"));
    await writeFile(resolve(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(resolve(root, ".pi-cloud-home"));
    await writeFile(resolve(root, ".pi-cloud-home/.git-credentials"), "secret\n");
    await mkdir(resolve(root, "nested/.git"), { recursive: true });
    await writeFile(resolve(root, "nested/.git/config"), "[core]\n");
    await mkdir(resolve(root, "src"));
    await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        writeFile(resolve(root, `src/file-${String(index).padStart(3, "0")}.txt`), `${index}\n`),
      ),
    );

    const index = await captureWorkspaceIndex(root);
    const files = index.files;
    expect(index.portable).toBe(true);
    expect(files).toHaveLength(601);
    expect(files[0]?.path).toBe("nested/.git/config");
    expect(files.some((file) => file.path === ".git/HEAD")).toBe(false);
    expect(files.some((file) => file.path.startsWith(".pi-cloud-home/"))).toBe(false);
  });

  it("indexes symlinks without following them", async () => {
    const root = await temporaryDirectory("pi-cloud-cube-workspace-link-");
    await writeFile(resolve(root, "target.txt"), "target\n");
    await symlink("target.txt", resolve(root, "link.txt"));
    const index = await captureWorkspaceIndex(root);
    expect(index.portable).toBe(false);
    expect(index.files.map((file) => file.path)).toEqual(["link.txt", "target.txt"]);
    const link = index.files[0];
    const target = index.files[1];
    expect(link).toMatchObject({
      path: "link.txt",
      executable: false,
      sizeBytes: Buffer.byteLength("target.txt"),
    });
    expect(link?.sha256).not.toBe(target?.sha256);
  });

  it("round-trips a persistent Workspace Volume reference without embedding file bytes", () => {
    const checkpoint = createPersistentVolumeReference({
      volumeId: `pcw-${"a".repeat(48)}`,
      volumeRevision: "f".repeat(64),
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-volume",
      workspaceId: "workspace-volume",
      sourceSessionId: "session-volume",
      bindingSha256: "b".repeat(64),
      fencingToken: 9,
      imageRevision: "development",
      environmentSpecSha256: "c".repeat(64),
      files: [
        {
          path: "src/result.txt",
          executable: false,
          sizeBytes: 7,
          sha256: "d".repeat(64),
        },
      ],
      recipeCommands: [],
    });
    expect(parsePersistentVolumeReference(checkpoint)).toMatchObject({
      volumeRevision: "f".repeat(64),
      tenantId: "tenant-volume",
      workspaceId: "workspace-volume",
      sourceSessionId: "session-volume",
      fencingToken: 9,
      totalSizeBytes: 7,
    });
    expect(workspaceSnapshotMetadata(checkpoint)).toEqual([
      expect.objectContaining({ path: "src/result.txt", sizeBytes: 7 }),
    ]);
    expect(() => parseWorkspaceSnapshot(checkpoint)).toThrow(/portable file bytes/);

    const withUnexpectedField = JSON.parse(Buffer.from(checkpoint).toString("utf8")) as Record<
      string,
      unknown
    >;
    withUnexpectedField.untrusted = true;
    expect(
      parsePersistentVolumeReference(Buffer.from(JSON.stringify(withUnexpectedField))),
    ).toBeUndefined();

    const previousLayout = {
      ...(JSON.parse(Buffer.from(checkpoint).toString("utf8")) as Record<string, unknown>),
      format: "pi-cloud.workspace-volume-reference.v0",
    };
    expect(
      parsePersistentVolumeReference(Buffer.from(JSON.stringify(previousLayout))),
    ).toBeUndefined();
  });
});
