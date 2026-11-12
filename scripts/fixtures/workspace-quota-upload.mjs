import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { workspaceVolumeId } from "../../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";
import { UploadStagingArea } from "../../packages/workspace-runtime/src/upload-staging.ts";
import { workspaceFileTransfer } from "../../packages/workspace-runtime/src/workspace-file-transfer.ts";

const root = process.env.PI_CLOUD_QUOTA_TEST_ROOT;
assert(root?.startsWith("/scratch/"), "Only the owned disposable quota fixture is permitted");
const key = "/scratch/quota-key";
await writeFile(key, "owned-quota-fixture-key\n", { mode: 0o600 });
const receiptServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ accepted: body.events.length }));
});
await new Promise((resolve) => receiptServer.listen(0, "127.0.0.1", resolve));
const process_ = spawn("/scratch/workspace-quota", [], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    PI_CLOUD_WORKSPACE_POSIX_ROOT: root,
    PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: key,
    PI_CLOUD_METERING_TOKEN_FILE: key,
    PI_CLOUD_RESOURCE_METERING_URL: `http://127.0.0.1:${receiptServer.address().port}/receipts`,
    PI_CLOUD_RESOURCE_METERING_SOURCE_ID: "owned-quota-contract",
  },
});
const exited = new Promise((resolve) => process_.once("exit", resolve));
const post = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:4510${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer owned-quota-fixture-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
let rootFD;
try {
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try {
      ready = (
        await fetch("http://127.0.0.1:4510/health/ready", { signal: AbortSignal.timeout(1000) })
      ).ok;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  assert(ready, "Quota helper did not become ready");
  const identity = {
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    generation: "b".repeat(64),
  };
  identity.volumeId = workspaceVolumeId(identity);
  const directory = join(root, `picloud-posix-${identity.volumeId}`),
    workspace = join(directory, "workspace");
  const pool = await (
    await fetch("http://127.0.0.1:4510/v1/pool", {
      headers: { authorization: "Bearer owned-quota-fixture-key" },
    })
  ).json();
  const storageIdentity = { ...identity, poolId: pool.id };
  const prepared = await post("/v1/storage/prepare", { ...storageIdentity, initialize: true });
  assert.equal(prepared.ready, true);
  assert.equal(
    (await post("/v1/storage/inspect", storageIdentity)).generation,
    identity.generation,
  );
  await post("/v1/quota/ensure", { ...identity, revision: 1, capacityBytes: 8 * 1024 ** 2 });
  rootFD = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY);
  const staging = new UploadStagingArea(join(directory, ".pi-cloud-runtime/uploads-v1"));
  await staging.prepare();
  const content = Buffer.alloc(12 * 1024 ** 2, 0x52);
  const make = (name) => ({
    fileTransferProtocolVersion: 1,
    type: "workspace.file_transfer",
    requestId: randomUUID(),
    uploadId: randomUUID(),
    claimToken: randomUUID(),
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    sessionId: randomUUID(),
    rootPath: "",
    name,
    relativePath: name,
    byteLength: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createParents: false,
    action: "create",
  });
  const execute = (input, change = {}, chunks) =>
    staging.use((files) => workspaceFileTransfer(rootFD, files, { ...input, ...change }, chunks));
  async function fill(input) {
    let state = await execute(input),
      quotaError;
    while (state.offset < content.length) {
      const chunk = content.subarray(
        state.offset,
        Math.min(content.length, state.offset + 1024 ** 2),
      );
      try {
        state = await execute(
          input,
          { action: "append", offset: state.offset, chunkLength: chunk.length },
          (async function* () {
            yield chunk;
          })(),
        );
      } catch (error) {
        quotaError = error;
        break;
      }
    }
    assert(["EDQUOT", "ENOSPC"].includes(quotaError?.code), "A real quota must stop the stream");
    return execute(input, { action: "status" });
  }
  const cancelled = make("cancelled.bin"),
    full = await fill(cancelled);
  assert(full.offset > 0 && full.offset < content.length);
  assert.equal((await execute(cancelled, { action: "cancel" })).state, "cancelled");
  assert.equal((await execute(cancelled, { action: "cancel" })).state, "cancelled");
  await assert.rejects(readFile(join(workspace, "cancelled.bin")), { code: "ENOENT" });
  const resumed = make("resumed.bin"),
    before = await fill(resumed);
  await post("/v1/quota/ensure", { ...identity, revision: 2, capacityBytes: 32 * 1024 ** 2 });
  let state = await execute(resumed, { action: "status" });
  assert.equal(state.offset, before.offset);
  while (state.state !== "ready") {
    const chunk = content.subarray(
      state.offset,
      Math.min(content.length, state.offset + 1024 ** 2),
    );
    state = await execute(
      resumed,
      { action: "append", offset: state.offset, chunkLength: chunk.length },
      (async function* () {
        yield chunk;
      })(),
    );
  }
  assert.equal((await stat(join(workspace, "resumed.bin"))).size, content.length);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(workspace, "resumed.bin")))
      .digest("hex"),
    resumed.sha256,
  );
  const bash = spawn(
    "bash",
    [
      "-c",
      'dd if=/dev/zero of="$1/ordinary-bash" bs=1M count=40 status=none',
      "owned-quota",
      workspace,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let output = "";
  bash.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => bash.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(output, /quota|space/i);
  await rm(join(workspace, "ordinary-bash"), { force: true });
  await rootFD.close();
  rootFD = undefined;
  const canary = join(root, "storage-canary");
  await writeFile(canary, "KEEP");
  await mkdir(join(workspace, "root-owned"));
  await writeFile(join(workspace, "root-owned", "unreadable"), "owned", { mode: 0 });
  const { symlink, chmod } = await import("node:fs/promises");
  await symlink(canary, join(workspace, "root-owned", "outside"));
  await chmod(join(workspace, "root-owned"), 0);
  await writeFile(
    join(directory, ".pi-cloud-runtime/delete-authorized"),
    `pi-cloud-volume-delete-v1\n${identity.volumeId}\n${identity.generation}\n`,
  );
  await post("/v1/storage/destroy", storageIdentity);
  await post("/v1/storage/destroy", storageIdentity);
  await assert.rejects(stat(workspace), { code: "ENOENT" });
  assert.equal(await readFile(canary, "utf8"), "KEEP");
  console.log(
    "workspace_quota_upload_contract_passed initialize cancellation growth resume ordinary_bash root_file_deletion symlink_canary",
  );
} finally {
  await rootFD?.close();
  process_.kill("SIGTERM");
  await exited;
  await new Promise((resolve) => receiptServer.close(resolve));
}
