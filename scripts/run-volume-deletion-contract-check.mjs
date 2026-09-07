import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  workspaceVolumeId,
} from "../packages/tool-broker/src/index.ts";

// No host-wide privileges: the root-owned fixture exists only in this private
// temporary mount. The production plugin executes unchanged at its fixed path.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-cloud-volume-delete-contract-"));
const storage = join(root, "storage"),
  bin = join(root, "bin");
await mkdir(storage);
await mkdir(bin);
const input = { tenantId: "delete-contract", workspaceId: "root-files", sessionId: "test" };
input.volumeId = workspaceVolumeId(input);
const gateway = new PersistentVolumeWorkspaceVolumeGateway({ workspaceRoot: storage });
const local = join(storage, `picloud-posix-${input.volumeId}`);
const remote = `/data/cube-shared/volume/picloud-posix-${input.volumeId}`;
const marker = join(local, ".pi-cloud-runtime/delete-authorized");
const image = process.env.PI_CLOUD_TEST_IMAGE ?? "pi-cloud/tool-broker:production";
const docker = (script) =>
  exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--cap-add=DAC_OVERRIDE",
      "--user",
      "0:0",
      "--mount",
      `type=bind,src=${storage},dst=/data/cube-shared/volume`,
      "--mount",
      `type=bind,src=${bin},dst=/test-bin,readonly`,
      "--mount",
      `type=bind,src=${resolve("deploy/cubesandbox/cube-volume-picloud-posix.sh")},dst=/plugin,readonly`,
      "--entrypoint",
      "bash",
      image,
      "-eu",
      "-c",
      script,
    ],
    { timeout: 60000, maxBuffer: 16384 },
  );
const destroy = `/bin/bash /plugin --op destroy --volume-id ${input.volumeId}`;
const pluginRejected = (error) =>
  error.code === 1 && error.stdout?.includes("POSIX volume operation failed");
try {
  await gateway.prepare(input);
  await writeFile(join(storage, "canary"), "DO_NOT_DELETE");
  await docker(
    `mkdir -p '${remote}/workspace/root-owned'; printf protected > '${remote}/workspace/root-owned/secret'; ln -s /data/cube-shared/volume/canary '${remote}/workspace/root-owned/outside'; chmod 000 '${remote}/workspace/root-owned/secret' '${remote}/workspace/root-owned'; printf first > '${remote}/workspace/first'`,
  );
  await assert.rejects(docker(destroy), pluginRejected);
  await gateway.prepareDelete(input);
  const authorizedMarker = await readFile(marker, "utf8");
  await assert.rejects(gateway.prepare(input), { code: "workspace_volume_deleting" });
  await assert.rejects(gateway.finalizeDelete(input), { code: "workspace_volume_delete_pending" });
  await chmod(marker, 0o600);
  await writeFile(marker, authorizedMarker.replace(input.volumeId, "pcw-" + "f".repeat(48)));
  await assert.rejects(docker(destroy), pluginRejected);
  await gateway.prepareDelete(input);
  await writeFile(
    join(bin, "rm"),
    `#!/bin/bash\n/bin/rm -f -- '${remote}/workspace/first'\nexit 77\n`,
    { mode: 0o755 },
  );
  await assert.rejects(docker(`PATH=/test-bin:/usr/bin:/bin ${destroy}`), pluginRejected);
  assert.equal(await readFile(marker, "utf8"), authorizedMarker);
  await assert.rejects(lstat(join(local, "workspace/first")), { code: "ENOENT" });
  await gateway.prepareDelete(input);
  await docker(destroy);
  await docker(destroy); // lost ACK: same native destroy is idempotent
  assert.equal(await readFile(join(storage, "canary"), "utf8"), "DO_NOT_DELETE");
  assert.equal(await readFile(marker, "utf8"), authorizedMarker);
  await gateway.finalizeDelete(input);
  await gateway.finalizeDelete(input);
  await assert.rejects(lstat(local), { code: "ENOENT" });
  console.log(
    "volume_deletion_contract_passed root_000_files missing_marker wrong_generation partial_failure lost_ack symlink_canary finalization",
  );
} finally {
  // This explicit path belongs solely to this invocation's disposable fixture.
  await docker(`/bin/rm -rf --one-file-system -- '${remote}/workspace'`).catch(() => undefined);
  await gateway.close();
  await rm(root, { recursive: true, force: true });
}
