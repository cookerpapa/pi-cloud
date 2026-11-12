import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeWorkspacePoolPlan, workspacePoolPaths } from "./workspace-storage-pool.mjs";

/** Cold validation only. Missing metadata never proves an empty holder set. */
export async function verifyNativeVolumeAttachmentState(options, assertQuiescent) {
  const paths = workspacePoolPaths(options.runtimeDirectory);
  const cluster = JSON.parse(
    await readFile(join(options.runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  assert.equal(
    cluster.providerContractVersion,
    1,
    "Install the stock native provider contract first",
  );
  const proof = await assertQuiescent();
  assert(
    proof?.runtimeQuiescent && proof.physicalVMsAbsent,
    "Cold physical retirement proof is required",
  );
  let verified = 0;
  for (const entry of normalizeWorkspacePoolPlan(options.workspaces)) {
    if (entry.generation === null) continue;
    await assertQuiescent();
    const metadata = join(paths.canonical, `picloud-posix-${entry.volumeId}`, ".pi-cloud-runtime");
    const stat = await lstat(metadata);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), "Volume metadata path changed");
    assert.equal(
      await readFile(join(metadata, "identity"), "utf8"),
      `pi-cloud-volume-v1\n${entry.volumeId}\n${entry.generation}\n`,
      "Frozen Volume generation changed",
    );
    const path = join(metadata, "attachments");
    const existing = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    assert(existing, "Native attachment state is missing; do not invent zero holders");
    assert(
      existing.isDirectory() && !existing.isSymbolicLink(),
      "Native attachment state changed type",
    );
    assert.equal(
      (await readdir(path)).length,
      0,
      "Unconfirmed attachment holds block native replacement",
    );
    verified++;
  }
  return { contract: 1, verified };
}
