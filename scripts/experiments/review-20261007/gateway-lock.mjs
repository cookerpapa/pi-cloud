// Real Gateway methods and filesystem flock; no production data.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  FilesystemWorkspaceVolumeGatewayLock,
  PersistentVolumeWorkspaceVolumeGateway,
  workspaceVolumeId,
} from "../../../packages/sandbox-control/src/index.ts";
import { createPluginVolumeFixture } from "../../../packages/sandbox-control/test/fixtures/plugin-volume.ts";
const root = await mkdtemp(join(tmpdir(), "review-volume-block-"));
const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), sessionId: randomUUID() };
const volumeId = workspaceVolumeId(scope);
await createPluginVolumeFixture(root, { volumeId });
const gateway = () =>
  new PersistentVolumeWorkspaceVolumeGateway({
    workspaceRoot: root,
    lock: new FilesystemWorkspaceVolumeGatewayLock(root, 100),
    authorizeUpload: async () => {},
  });
let release, started;
const waiting = new Promise((r) => (release = r));
const began = new Promise((r) => (started = r));
const upload = gateway().uploadFile(
  {
    ...scope,
    volumeId,
    uploadId: randomUUID(),
    claimToken: randomUUID(),
    name: "large.txt",
    rootPath: "",
    byteLength: 2,
    sha256: createHash("sha256").update("ab").digest("hex"),
  },
  (async function* () {
    yield Buffer.from("a");
    started();
    await waiting;
    yield Buffer.from("b");
  })(),
);
let code;
try {
  await began;
  const at = performance.now();
  try {
    await gateway().listDirectory({ ...scope, volumeId, rootPath: "", path: "" });
    code = "allowed";
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "allowed");
  release();
  await upload;
  await gateway().listDirectory({ ...scope, volumeId, rootPath: "", path: "" });
  const result = {
    duringStreamingUpload: code,
    afterUpload: "read succeeds",
    waitMs: 100,
    elapsedMs: performance.now() - at,
    scope: "two Gateway instances, real filesystem flock, owned fixture, no production data",
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  release();
  await upload.catch(() => {});
  await rm(root, { recursive: true, force: true });
}
