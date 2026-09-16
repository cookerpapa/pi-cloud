import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-cloud-volume-init-contract-"));
const storage = join(root, "storage"),
  bin = join(root, "bin");
await mkdir(storage);
await mkdir(bin);
const image = process.env.PI_CLOUD_TEST_IMAGE ?? "pi-cloud/tool-broker:production";
const volumes = [];
function volume(label) {
  const id = `pcw-${createHash("sha256").update(`${root}:${label}`).digest("hex").slice(0, 48)}`;
  const path = `/data/cube-shared/volume/picloud-posix-${id}`;
  const value = { id, path, identity: `${path}/.pi-cloud-runtime/identity` };
  volumes.push(value);
  return value;
}
async function docker(script) {
  const name = `pi-cloud-volume-init-${randomUUID()}`;
  try {
    return await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--pids-limit=128",
        "--memory=128m",
        "--cpus=1",
        "--cap-drop=ALL",
        "--cap-add=DAC_OVERRIDE",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--cap-add=KILL",
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
      { timeout: 60_000, maxBuffer: 64 * 1024 },
    );
  } finally {
    await exec("docker", ["rm", "--force", name]).catch((error) => {
      if (!String(error.stderr).includes("No such container")) throw error;
    });
  }
}
const create = (v) => `/bin/bash /plugin --op create --volume-id ${v.id}`;
const readIdentity = async (v) => (await docker(`cat '${v.identity}'`)).stdout;
const validIdentity = (v, value) =>
  assert.match(value, new RegExp(`^pi-cloud-volume-v1\\n${v.id}\\n[0-9a-f]{64}\\n$`));
try {
  const shared = volume("concurrent");
  const concurrent = await docker(
    `pids=(); for i in {1..20}; do ${create(shared)} & pids+=("$!"); done; for pid in "\${pids[@]}"; do wait "$pid"; done`,
  );
  const replies = concurrent.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 20);
  assert(replies.every((reply) => reply.error === ""));
  const original = await readIdentity(shared);
  validIdentity(shared, original);
  const attached = await docker(
    `/bin/bash /plugin --op attach --volume-id ${shared.id} --sandbox-id test-guest --namespace test --ref-count 1 --private-data picloud-posix-v2`,
  );
  assert.deepEqual(JSON.parse(attached.stdout), {
    host_path: `${shared.path}/workspace`,
    metadata: { driver: "picloud-posix-v2" },
    error: "",
  });
  await docker(
    `/bin/bash /plugin --op detach --volume-id ${shared.id} --sandbox-id test-guest --namespace test --ref-count 0 --metadata '{"driver":"picloud-posix-v2"}'`,
  );
  assert.equal(await readIdentity(shared), original);
  await docker(
    `printf 'USER-DATA' > '${shared.path}/workspace/keep.txt'; chmod 0400 '${shared.path}/workspace/keep.txt'; ${create(shared)}`,
  );
  assert.equal(await readIdentity(shared), original);
  assert.equal(
    (
      await docker(
        `cat '${shared.path}/workspace/keep.txt'; stat -c %a '${shared.path}/workspace/keep.txt'`,
      )
    ).stdout,
    "USER-DATA400\n",
  );

  const before = volume("killed-before-publication");
  await writeFile(join(bin, "ln"), '#!/bin/bash\nkill -KILL "$PPID"\nexit 137\n', { mode: 0o755 });
  await assert.rejects(
    docker(`PATH=/test-bin:/usr/bin:/bin ${create(before)}; printf 'unexpected completion'`),
    (error) => error.code === 137,
  );
  await rm(join(bin, "ln"));
  await docker(`test ! -e '${before.identity}'`);
  await docker(create(before));
  validIdentity(before, await readIdentity(before));
  assert.equal((await docker(`ls -A '${before.path}/.pi-cloud-runtime'`)).stdout, "identity\n");

  const after = volume("killed-after-publication");
  await writeFile(
    join(bin, "sync"),
    '#!/bin/bash\nif [[ "$2" == */.pi-cloud-runtime ]]; then kill -KILL "$PPID"; exit 137; fi\nexec /usr/bin/sync "$@"\n',
    { mode: 0o755 },
  );
  await assert.rejects(
    docker(`PATH=/test-bin:/usr/bin:/bin ${create(after)}; printf 'unexpected completion'`),
    (error) => error.code === 137,
  );
  await rm(join(bin, "sync"));
  const published = await readIdentity(after);
  validIdentity(after, published);
  await docker(create(after));
  assert.equal(await readIdentity(after), published);
  assert.equal((await docker(`ls -A '${after.path}/.pi-cloud-runtime'`)).stdout, "identity\n");

  const unknown = volume("unknown-nonempty");
  await docker(
    `mkdir -p '${unknown.path}/workspace'; printf 'DO-NOT-ADOPT' > '${unknown.path}/workspace/keep.txt'`,
  );
  await assert.rejects(docker(create(unknown)));
  assert.equal(
    (await docker(`cat '${unknown.path}/workspace/keep.txt'; test ! -e '${unknown.identity}'`))
      .stdout,
    "DO-NOT-ADOPT",
  );
  const invalid = volume("existing-invalid-identity");
  await docker(
    `mkdir -p '${invalid.path}/workspace' '${invalid.path}/.pi-cloud-runtime'; printf invalid > '${invalid.identity}'`,
  );
  await assert.rejects(docker(create(invalid)));
  assert.equal(await readIdentity(invalid), "invalid");
  console.log(
    JSON.stringify({
      volumeInitialization: "passed",
      concurrentCreates: 20,
      preservedNodeMountContract: true,
      killedBeforePublication: true,
      killedAfterPublication: true,
      preservedIdentityAndUserData: true,
      rejectedUnknownLayouts: true,
    }),
  );
} finally {
  await docker(`/bin/rm -rf --one-file-system -- ${volumes.map((v) => `'${v.path}'`).join(" ")}`);
  await rm(root, { recursive: true, force: true });
}
