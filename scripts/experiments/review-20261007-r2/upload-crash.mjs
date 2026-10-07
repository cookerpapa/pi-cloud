// Actual Gateway and flock, owned local directory, fixture authorization.
// Verifies cold maintenance and retry after process loss; no PG or production data.
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  workspaceVolumeId,
} from "../../../packages/sandbox-control/src/index.ts";
import { createPluginVolumeFixture } from "../../../packages/sandbox-control/test/fixtures/plugin-volume.ts";

const root = await mkdtemp(join(tmpdir(), "review-upload-crash-"));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = new URL("../../../packages/sandbox-control/src/index.ts", import.meta.url).href;
const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), sessionId: randomUUID() };
const volumeId = workspaceVolumeId(scope),
  bytes = Buffer.alloc(2 * 1024 * 1024, 65);
const request = {
  ...scope,
  volumeId,
  uploadId: randomUUID(),
  claimToken: randomUUID(),
  name: "complete.bin",
  rootPath: "",
  byteLength: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const directory = join(root, "picloud-posix-" + volumeId, "workspace/uploads", request.uploadId);
let child, gateway;
try {
  await createPluginVolumeFixture(root, { volumeId });
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = `import { PersistentVolumeWorkspaceVolumeGateway } from ${JSON.stringify(source)};
      const input=JSON.parse(process.argv[2]);
      const gateway=new PersistentVolumeWorkspaceVolumeGateway({workspaceRoot:process.argv[1],authorizeUpload:async()=>{}});
      await gateway.uploadFile(input,(async function*(){yield Buffer.alloc(65536,65);
        process.stdout.write('staged\\n');await new Promise(resolve=>process.stdin.once('data',resolve));
        yield Buffer.alloc(input.byteLength-65536,65);})());`;
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code, root, JSON.stringify(request)],
      { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 10000;
    while (!output.includes("staged")) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw Error("Upload child did not reach staging");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    child = undefined;
  }
  gateway = new PersistentVolumeWorkspaceVolumeGateway({
    workspaceRoot: root,
    authorizeUpload: async () => {},
  });
  const stagingDirectory = join(
    root,
    "picloud-posix-" + volumeId,
    ".pi-cloud-runtime",
    "uploads-v1",
    "files",
  );
  const beforeMaintenance = await readdir(stagingDirectory);
  assert(beforeMaintenance.length > 0);
  const reclaimed = await gateway.reapUploads();
  assert(reclaimed.files > 0);
  assert.deepEqual(await readdir(stagingDirectory), []);
  await gateway.uploadFile(
    { ...request, claimToken: randomUUID() },
    (async function* () {
      yield bytes;
    })(),
  );
  await gateway.close();
  gateway = undefined;
  const files = await Promise.all(
    (await readdir(directory)).map(async (name) => ({
      name,
      bytes: (await stat(join(directory, name))).size,
    })),
  );
  const partials = files.filter((file) => file.name.startsWith(".upload-"));
  assert.equal(partials.length, 0);
  assert.deepEqual(await readdir(stagingDirectory), []);
  assert.equal(files.find((file) => file.name === "complete.bin").bytes, bytes.length);
  const result = {
    scope:
      "Actual Gateway/filesystem, three process SIGKILLs, cold maintenance without retry, then same upload identity retry; authorization fixture, no production data",
    completedBytes: bytes.length,
    withoutRetry: reclaimed,
    orphanFiles: partials.length,
    orphanBytes: partials.reduce((n, file) => n + file.bytes, 0),
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await gateway?.close();
  await rm(root, { recursive: true, force: true });
}
