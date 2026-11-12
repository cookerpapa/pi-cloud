import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyNativeVolumeAttachmentState } from "./native-volume-attachment-state.mjs";

it("validates current cold attachments without reconstructing missing native holds", async () => {
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
    await writeFile(clusterPath, JSON.stringify({ providerContractVersion: 1 }));
    await writeFile(join(metadata, "identity"), `pi-cloud-volume-v1\n${volumeId}\n${generation}\n`);
    await writeFile(join(metadata, "original"), "PRESERVE");
    await expect(
      verifyNativeVolumeAttachmentState(options, async () => ({
        runtimeQuiescent: false,
        physicalVMsAbsent: true,
      })),
    ).rejects.toThrow("proof");
    await expect(verifyNativeVolumeAttachmentState(options, proof)).rejects.toThrow(
      "do not invent zero",
    );
    await mkdir(join(metadata, "attachments"));
    expect(await verifyNativeVolumeAttachmentState(options, proof)).toEqual({
      contract: 1,
      verified: 1,
    });
    await writeFile(clusterPath, JSON.stringify({ providerContractVersion: 1 }));
    await writeFile(join(metadata, "attachments/unknown"), "unconfirmed holder");
    await expect(verifyNativeVolumeAttachmentState(options, proof)).rejects.toThrow(
      "Unconfirmed attachment",
    );
    expect(await readFile(join(metadata, "attachments/unknown"), "utf8")).toBe(
      "unconfirmed holder",
    );
    await rm(join(metadata, "attachments"), { recursive: true });
    await expect(verifyNativeVolumeAttachmentState(options, proof)).rejects.toThrow(
      "do not invent zero",
    );
    expect(await readFile(join(metadata, "original"), "utf8")).toBe("PRESERVE");
    expect((await readdir(metadata)).includes("attachments")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
