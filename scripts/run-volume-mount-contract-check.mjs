import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pma-volume-attachments-"));
const storage = join(root, "storage");
await mkdir(storage);
const id = `pcw-${randomBytes(24).toString("hex")}`;
const local = join(storage, `picloud-posix-${id}`);
const holds = join(local, ".pi-cloud-runtime/attachments");
const generation = randomBytes(32).toString("hex"),
  poolId = "owned-mount-fixture";
const privateData = `pma-posix-v1:${poolId}:${generation}`;
const image = process.env.PI_CLOUD_TEST_IMAGE ?? "pi-cloud/workspace-volume-gateway:production";
const rejected = (e) => e.code === 1 && e.stdout?.includes("POSIX volume operation failed");
async function plugin(op, args = []) {
  const result = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--cap-add=DAC_OVERRIDE",
      "--cap-add=CHOWN",
      "--cap-add=FOWNER",
      "--user",
      "0:0",
      "--mount",
      `type=bind,src=${storage},dst=/data/cube-shared/volume`,
      "--mount",
      `type=bind,src=${resolve("deploy/cubesandbox/cube-volume-picloud-posix.sh")},dst=/plugin,readonly`,
      "--entrypoint",
      "bash",
      image,
      "/plugin",
      "--op",
      op,
      "--volume-id",
      id,
      "--private-data",
      privateData,
      ...args,
    ],
    { timeout: 60000, maxBuffer: 16384 },
  );
  return JSON.parse(result.stdout);
}
const attach = () =>
  plugin("attach", ["--sandbox-id", "same-native-vm", "--namespace", "test", "--ref-count", "0"]);
const detach = (metadata, sandbox = "same-native-vm") =>
  plugin("detach", [
    "--sandbox-id",
    sandbox,
    "--namespace",
    "test",
    "--ref-count",
    "0",
    "--metadata",
    JSON.stringify(metadata),
  ]);
try {
  // Byte initialization belongs to storage. The native mount adapter must not
  // invent a volume when it cannot find the registered storage identity.
  await assert.rejects(plugin("create"), rejected);
  await mkdir(holds, { recursive: true });
  await mkdir(join(local, "workspace"));
  await writeFile(
    join(storage, ".pi-cloud-workspace-pool"),
    `pi-cloud-workspace-pool-v1\n${poolId}\n`,
  );
  await writeFile(join(local, ".pi-cloud-runtime/storage-pool"), `${poolId}\n`);
  await writeFile(
    join(local, ".pi-cloud-runtime/identity"),
    `pi-cloud-volume-v1\n${id}\n${generation}\n`,
  );
  assert.equal((await plugin("create")).private_data, privateData);
  assert.equal((await plugin("create")).private_data, privateData);
  await plugin("destroy"); // Removing a native registration alone keeps storage.
  assert.equal((await plugin("create")).private_data, privateData);
  await assert.rejects(
    plugin("attach", [
      "--sandbox-id",
      "wrong-pool",
      "--namespace",
      "test",
      "--ref-count",
      "0",
      "--private-data",
      `pma-posix-v1:other:${generation}`,
    ]),
    rejected,
  );
  await writeFile(join(local, "workspace/keep"), "ORIGINAL-WORKSPACE");
  const first = await attach();
  const second = await attach();
  assert.notEqual(first.metadata.hold, second.metadata.hold);
  assert.equal((await readdir(holds)).length, 2);
  await detach({}); // lost Attach metadata cannot clear another holder
  assert.equal((await readdir(holds)).length, 2);
  await assert.rejects(detach(first.metadata, "another-vm"), rejected);
  await detach(first.metadata);
  await detach(first.metadata); // duplicate/late Detach cannot clear the new call
  assert.equal((await readdir(holds)).length, 1);
  await writeFile(
    join(local, ".pi-cloud-runtime/delete-authorized"),
    `pi-cloud-volume-delete-v1\n${id}\n${generation}\n`,
  );
  await assert.rejects(attach(), rejected);
  await assert.rejects(plugin("destroy"), rejected); // native refcount=0 is insufficient
  assert.equal(await readFile(join(local, "workspace/keep"), "utf8"), "ORIGINAL-WORKSPACE");
  await rename(holds, `${holds}.missing`);
  await assert.rejects(plugin("destroy"), rejected);
  await assert.rejects(attach(), rejected);
  await rename(`${holds}.missing`, holds);
  await detach(second.metadata);
  assert.equal((await readdir(holds)).length, 0);
  await plugin("destroy");
  await plugin("destroy");
  assert.equal(await readFile(join(local, "workspace/keep"), "utf8"), "ORIGINAL-WORKSPACE");
  console.log(
    "volume_mount_contract_passed registration_only wrong_pool duplicate_attach late_detach missing_metadata native_zero_ref lost_hold_directory closed_admission original_bytes",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
