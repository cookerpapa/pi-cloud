import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceVolumeId } from "../../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";

/** Native registration retirement, never byte deletion. Run only after cold
 * adoption and after the no-byte-delete supported hook is actually installed. */
export async function retireWorkspaceRegistrations({
  database,
  native,
  domainId,
  root,
  kubectl,
  assertQuiescent,
}) {
  await assertQuiescent();
  const expected = createHash("sha256")
    .update(await readFile(resolve(root, "deploy/cubesandbox/cube-volume-picloud-posix.sh")))
    .digest("hex");
  const actual = kubectl([
    "exec",
    "deployment/cube-master",
    "--",
    "sha256sum",
    "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
  ])
    .trim()
    .split(/\s/)[0];
  assert.equal(actual, expected, "Do not retire registrations with the old byte-deleting hook");
  const rows = await database
    .selectFrom("workspaces")
    .select(["id", "tenant_id", "persistence_state"])
    .where("sandbox_domain_id", "=", domainId)
    .where("storage_purged_at", "is", null)
    .orderBy("id")
    .execute();
  let retired = 0;
  for (const row of rows) {
    assert(
      ["ready", "uninitialized"].includes(row.persistence_state),
      "Finish storage adoption before native registration retirement",
    );
    await assertQuiescent();
    const id = workspaceVolumeId({ tenantId: row.tenant_id, workspaceId: row.id });
    await native.deleteVolume(id);
    const until = Date.now() + 30_000;
    while (await native.hasVolume(id)) {
      assert(Date.now() < until, "Native registration retirement is unconfirmed");
      await assertQuiescent();
      await delay(250);
    }
    retired++;
  }
  return { retiredRegistrations: retired, workspaceBytesDeleted: false };
}
