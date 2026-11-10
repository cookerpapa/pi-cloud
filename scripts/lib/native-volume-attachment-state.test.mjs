import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { initializeNativeVolumeAttachmentState } from "./native-volume-attachment-state.mjs";

it("initializes only the retired old format and never reconstructs missing native holds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pma-volume-cutover-"));
  const tenantId = randomUUID(),
    workspaceId = randomUUID(),
    generation = "a".repeat(64);
  const volumeId = `pcw-${createHash("sha256").update(`pi-cloud.workspace-volume.v1\0${tenantId}\0${workspaceId}`).digest("hex").slice(0, 48)}`;
  const metadata = join(
    root,
    "state/cube-shared/volume",
    `picloud-posix-${volumeId}`,
    ".pi-cloud-runtime",
  );
  const clusterPath = join(root, "cubesandbox/cluster.json");
  const proof = vi.fn(async () => ({ runtimeQuiescent: true, physicalVMsAbsent: true }));
  const options = {
    runtimeDirectory: root,
    workspaces: [
      { tenantId, workspaceId, generation, volumeId, capacityBytes: 1024 ** 3, revision: 1 },
    ],
  };
  try {
    await mkdir(metadata, { recursive: true });
    await mkdir(join(root, "cubesandbox"));
    await writeFile(clusterPath, JSON.stringify({ executionProtocolVersion: 10 }));
    await writeFile(join(metadata, "identity"), `pi-cloud-volume-v1\n${volumeId}\n${generation}\n`);
    await writeFile(join(metadata, "original"), "PRESERVE");
    await expect(
      initializeNativeVolumeAttachmentState(options, async () => ({
        runtimeQuiescent: false,
        physicalVMsAbsent: true,
      })),
    ).rejects.toThrow("proof");
    expect(await initializeNativeVolumeAttachmentState(options, proof)).toEqual({
      contract: 1,
      initialized: 1,
      verified: 1,
    });
    expect(await initializeNativeVolumeAttachmentState(options, proof)).toEqual({
      contract: 1,
      initialized: 0,
      verified: 1,
    });
    await writeFile(clusterPath, JSON.stringify({ providerContractVersion: 1 }));
    await writeFile(join(metadata, "attachments/unknown"), "unconfirmed holder");
    await expect(initializeNativeVolumeAttachmentState(options, proof)).rejects.toThrow(
      "Unconfirmed attachment",
    );
    expect(await readFile(join(metadata, "attachments/unknown"), "utf8")).toBe(
      "unconfirmed holder",
    );
    await rm(join(metadata, "attachments"), { recursive: true });
    await expect(initializeNativeVolumeAttachmentState(options, proof)).rejects.toThrow(
      "do not invent zero",
    );
    expect(await readFile(join(metadata, "original"), "utf8")).toBe("PRESERVE");
    expect((await readdir(metadata)).includes("attachments")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
