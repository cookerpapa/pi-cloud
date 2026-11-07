import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";

configureBuildProxy();
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "pi-cloud-quota-contract-"));
const image = "pi-cloud/workspace-quota-contract:20261107";
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)),
    );
  });
try {
  await run("docker", [
    "build",
    "--network=host",
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "HTTPS_PROXY",
    "--build-arg",
    "NO_PROXY",
    "-f",
    "deploy/workspace-quota/Dockerfile.contract",
    "-t",
    image,
    ".",
  ]);
  const modules = execFileSync("go", ["env", "GOMODCACHE"], { encoding: "utf8" }).trim();
  await run("docker", [
    "run",
    "--rm",
    "--privileged",
    "--network=none",
    "--cpus=2",
    "--memory=2g",
    "-v",
    `${root}:/repo:ro`,
    "-v",
    `${scratch}:/scratch`,
    "-v",
    `${modules}:/modules:ro`,
    "-e",
    "GOMODCACHE=/modules",
    "-e",
    "GOTOOLCHAIN=local",
    "-e",
    "GOMAXPROCS=2",
    "-e",
    "GOFLAGS=-p=1",
    "-e",
    "PI_CLOUD_QUOTA_TEST_ROOT=/scratch/mount",
    image,
    "bash",
    "-euc",
    `
      truncate -s 512M /scratch/pool.xfs
      mkfs.xfs -f -m reflink=1 /scratch/pool.xfs >/dev/null
      mkdir /scratch/mount
      first_loop=$(losetup --find --show /scratch/pool.xfs)
      second_loop=""
      trap 'umount /scratch/mount 2>/dev/null || true; losetup -d "$first_loop"; test -z "$second_loop" || losetup -d "$second_loop"' EXIT
      mount -o prjquota "$first_loop" /scratch/mount
      export PI_CLOUD_QUOTA_EXPECTED_UUID=$(blkid -s UUID -o value "$first_loop")
      go -C /repo/deploy/file-exchange build -buildvcs=false -mod=readonly -o /scratch/file-exchange .
      export PI_CLOUD_FILE_EXCHANGE_PATH=/scratch/file-exchange
      go -C /repo/deploy/workspace-quota test -buildvcs=false -mod=readonly ./...
      umount /scratch/mount
      second_loop=$(losetup --find --show /scratch/pool.xfs)
      test "$first_loop" != "$second_loop"
      mount -o prjquota "$second_loop" /scratch/mount
      go -C /repo/deploy/workspace-quota test -buildvcs=false -mod=readonly -run TestRealKernelFilesystemIdentitySurvivesRemount ./...
      go -C /repo/deploy/workspace-quota build -buildvcs=false -mod=readonly -o /scratch/workspace-quota ./cmd/workspace-quota
      node --import /repo/node_modules/tsx/dist/loader.mjs /repo/scripts/fixtures/workspace-quota-upload.mjs
    `,
  ]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
