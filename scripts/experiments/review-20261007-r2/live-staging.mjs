// Creates and removes one owned Cube VM/Volume. Exercises freshly bundled guest
// code on the installed native runtime; this is not a production release.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { build } from "esbuild";
import sharp from "sharp";
import { runtimeDirectory, repositoryRoot } from "../../lib/production-kubernetes.mjs";
import { OfficialCubeSandboxRuntimeClient } from "../../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  workspaceVolumeId,
} from "../../../packages/sandbox-control/src/index.ts";
const cluster = JSON.parse(await readFile(`${runtimeDirectory}/cubesandbox/cluster.json`, "utf8"));
const templates = JSON.parse(
  await readFile(`${runtimeDirectory}/cubesandbox/template.json`, "utf8"),
);
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: (await readFile(`${runtimeDirectory}/secrets/cubesandbox-api-key`, "utf8")).trim(),
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
  requestTimeoutMs: 60000,
});
const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), sessionId: randomUUID() },
  volumeId = workspaceVolumeId(scope);
const allocation = { id: randomUUID(), createBefore: Date.now() + 180000 };
const gateway = new PersistentVolumeWorkspaceVolumeGateway({
  workspaceRoot: `${runtimeDirectory}/state/cube-shared/volume`,
});
const report = {
  checkedAt: new Date().toISOString(),
  scope:
    "Owned native Cube plus freshly bundled guest helper, no PG Run or model; not a matched release",
  passed: false,
  cleanupConfirmed: false,
};
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bundleOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["sharp"],
  write: false,
  banner: {
    js: "import {createRequire as __r} from 'node:module';const require=__r(import.meta.url);",
  },
};
let created = false;
try {
  const bundled = await build({
    ...bundleOptions,
    entryPoints: [`${repositoryRoot}/packages/tool-sandbox/src/envd-input-files.ts`],
  });
  const code = bundled.outputFiles[0].contents;
  report.guestHelperSha256 = sha(code);
  const holder = await build({
    ...bundleOptions,
    stdin: {
      resolveDir: repositoryRoot,
      contents: `
    import { UploadStagingArea } from './packages/workspace-runtime/src/upload-staging.ts';
    import {writeFile} from 'node:fs/promises';
    const [directory,ready]=process.argv.slice(2);
    await new UploadStagingArea(directory).use(async files=>{
      await writeFile('/proc/self/fd/'+files.fd+'/.part-00000000-0000-4000-8000-000000000001',Buffer.alloc(65536,42));
      await writeFile(ready,String(process.pid));await new Promise(resolve=>setTimeout(resolve,60000));
    });`,
    },
  });
  await client.ensureVolume(volumeId, "picloud-posix");
  created = true;
  const instance = await client.create({
    allocation,
    templateId: templates.development.starter.templateId,
    timeoutSeconds: 600,
    metadata: { "picloud.managed": "true", "picloud.workload": "repair-upload-staging" },
    allowInternetAccess: false,
    allowPublicTraffic: false,
    volumeMounts: [{ name: volumeId, path: "/home/user" }],
  });
  const base = `/opt/pi-cloud/check-${allocation.id}`,
    cwd = "/home/user/repair-fixture",
    ready = `/tmp/repair-${allocation.id}.pid`;
  const run = async (command, user = "root") => {
    const result = await client.runCommand(instance, {
      command,
      cwd: "/",
      user,
      timeoutMs: 15000,
      maximumOutputBytes: 8192,
    });
    assert.equal(result.exitCode, 0, `Guest command failed: ${result.stderr.slice(-300)}`);
    return result.stdout.trim();
  };
  await run(`mkdir -p ${quote(base)} ${quote(cwd)} && chown 1000:1000 ${quote(cwd)}`);
  await client.writeGuestFile(instance, `${base}/input.mjs`, code);
  await client.writeGuestFile(instance, `${base}/holder.mjs`, holder.outputFiles[0].contents);
  const input = async (value) => {
    const path = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
    await client.writeGuestFile(instance, path, Buffer.from(JSON.stringify(value)));
    const source = value.sourcePath ? " " + quote(value.sourcePath) : "";
    const result = JSON.parse(
      await run(
        `chown 1000:1000 ${quote(path)}${source} && chmod 0400 ${quote(path)}${source} && /usr/bin/setpriv --reuid 1000 --regid 1000 --clear-groups --no-new-privs /usr/local/bin/node ${quote(base + "/input.mjs")} ${quote(path)}; rm -f ${quote(path)}`,
      ),
    );
    assert.equal(result.ok, true, "Guest input helper failed");
    return result.result;
  };
  const bytes = Buffer.from("owned upload acceptance\n"),
    id = randomUUID(),
    sourcePath = `/tmp/pi-cloud-upload-${randomUUID()}`;
  await client.writeGuestFile(instance, sourcePath, bytes);
  const request = {
    mode: "upload_file",
    directory: cwd,
    id,
    name: "note.txt",
    sha256: sha(bytes),
    byteLength: bytes.length,
    sourcePath,
  };
  const receipt = await input(request);
  assert.equal(receipt.sha256, sha(bytes));
  const area = cwd + "/.pi-cloud-upload-staging-v1";
  await run(
    `nohup setsid /usr/local/bin/node ${quote(base + "/holder.mjs")} ${quote(area)} ${quote(ready)} >/tmp/repair-holder.log 2>&1 </dev/null &`,
    "user",
  );
  let pid;
  for (let n = 0; n < 30; n++) {
    const result = await client.runCommand(instance, {
      command: `cat ${quote(ready)}`,
      cwd: "/",
      user: "user",
      timeoutMs: 1000,
      maximumOutputBytes: 128,
    });
    if (result.exitCode === 0 && /^\d+$/.test(result.stdout.trim())) {
      pid = Number(result.stdout.trim());
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(Number.isSafeInteger(pid) && pid > 1, "Owned staging holder did not start");
  const active = await input({ mode: "reap_upload_staging" });
  assert.equal(active.files, 0);
  assert.equal(active.busyAreas, 1);
  assert.equal(active.deferred, 0);
  await run(`/bin/kill -KILL ${pid}`);
  const reaped = await input({ mode: "reap_upload_staging" });
  assert.equal(reaped.files, 1);
  assert.equal(reaped.bytes, 65536);
  assert.equal(
    (await run(`sha256sum ${quote(cwd + "/" + receipt.relativePath)}`)).split(/\s/)[0],
    sha(bytes),
  );
  assert.deepEqual(await input(request), receipt);
  const image = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#229944" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const imagePath = `/tmp/pi-cloud-upload-${randomUUID()}`;
  await client.writeGuestFile(instance, imagePath, image);
  const normalized = await input({
    mode: "normalize_image",
    sourcePath: imagePath,
    byteLength: image.length,
    mimeType: "image/jpeg",
  });
  const metadata = await sharp(Buffer.from(normalized.data, "base64")).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.orientation], [40, 80, undefined]);
  report.activeWriter = active;
  report.afterSigkill = reaped;
  report.finalFilePreserved = true;
  report.identicalRetry = true;
  report.normalizedImage = { width: metadata.width, height: metadata.height };
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : "failed";
} finally {
  try {
    const closed = await client.allocation(allocation.id, allocation.createBefore, "close");
    if (created && closed.closed && closed.phase === "absent") {
      await gateway.prepareDelete({ ...scope, volumeId });
      await client.deleteVolume(volumeId);
      await gateway.finalizeDelete({ ...scope, volumeId });
      report.cleanupConfirmed = true;
    }
  } finally {
    await client.close();
    await gateway.close();
  }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
assert(report.passed && report.cleanupConfirmed, "Owned native staging acceptance failed");
