import assert from "node:assert/strict";
import { lstat, readFile, mkdir, chown, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeWorkspacePoolPlan, workspacePoolPaths } from "./workspace-storage-pool.mjs";

/** One-time, cold filesystem-format initialization. Runtime hooks never infer an
 * empty holder set from missing metadata. Existing holder files are never erased. */
export async function initializeNativeVolumeAttachmentState(options, assertQuiescent) {
  const paths = workspacePoolPaths(options.runtimeDirectory);
  const cluster = JSON.parse(
    await readFile(join(options.runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const initializing =
    cluster.providerContractVersion === undefined && cluster.executionProtocolVersion === 10;
  assert(
    initializing || cluster.providerContractVersion === 1,
    "Unsupported native Volume cutover source",
  );
  const proof = await assertQuiescent();
  assert(
    proof?.runtimeQuiescent && proof.physicalVMsAbsent,
    "Cold physical retirement proof is required",
  );
  let initialized = 0,
    verified = 0;
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
    if (!existing) {
      assert(initializing, "Native attachment state is missing; do not invent zero holders");
      await mkdir(path, { mode: 0o700 });
      await chown(path, stat.uid, stat.gid);
      for (const directory of [path, metadata]) {
        const file = await open(directory, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      }
      initialized++;
    } else
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
  return { contract: 1, initialized, verified };
}
