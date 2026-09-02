import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceVolumeSettlement,
  decodeWorkspaceBlob,
  encodeWorkspaceBlob,
  createWorkspaceSeed,
  parseWorkspaceSeed,
  parseWorkspaceVolumeSettlement,
  restoreWorkspaceSeed,
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
  it("restores a bounded initialization seed without replacing environment credentials", async () => {
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
    await writeFile(resolve(target, "stale.txt"), "remove me");
    await restoreWorkspaceSeed(target, restoredEnvelope);

    await expect(readFile(resolve(target, ".git/HEAD"), "utf8")).resolves.toBe(
      "ref: refs/heads/main\n",
    );
    await expect(readFile(resolve(target, "src/App.java"), "utf8")).resolves.toBe("class App {}\n");
    await expect(readFile(resolve(target, ".git-credentials"), "utf8")).resolves.toBe(
      "target-secret\n",
    );
    await expect(readFile(resolve(target, "stale.txt"), "utf8")).rejects.toThrow();
    expect((await stat(resolve(target, "test.sh"))).mode & 0o111).not.toBe(0);
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
