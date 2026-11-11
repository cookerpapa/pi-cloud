import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { kubectl, repositoryRoot, workload } from "./production-kubernetes.mjs";
import { join } from "node:path";

const directory = "/app/packages/cube-completion/src";
const config = "/tmp/pi-cloud-tool-reply-fault.json",
  state = "/tmp/pi-cloud-tool-reply-fault-state.json";
const mount = "/run/pi-cloud-acceptance";
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");
const run = (pod, source) =>
  kubectl(["exec", "-i", pod, "-c", "tool-completion", "--", "node", "--input-type=module", "-"], {
    input: `import fs from 'node:fs';\n${source}`,
    timeout: 30000,
  });
const readDeployment = () =>
  JSON.parse(kubectl(["get", workload("tool-completion"), "-o", "json"]));
const patchTemplate = (template) => {
  const temporary = mkdtempSync(join(tmpdir(), "picloud-reply-template-"));
  try {
    const path = join(temporary, "patch.json");
    writeFileSync(
      path,
      JSON.stringify([{ op: "replace", path: "/spec/template", value: template }]),
      { mode: 0o600 },
    );
    return kubectl(["patch", workload("tool-completion"), "--type=json", `--patch-file=${path}`], {
      timeout: 30000,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};
const ready = () =>
  kubectl(["rollout", "status", workload("tool-completion"), "--timeout=180s"], {
    timeout: 185000,
  });
const pods = () =>
  JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.filter(
    (p) =>
      !p.metadata.deletionTimestamp &&
      p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
  );
export function singleReadyCubelet() {
  const values = pods().filter((p) => p.spec.containers.some((c) => c.name === "cubelet"));
  assert.equal(values.length, 1, "Owned node fixture requires one Ready Cubelet");
  return values[0];
}
function singleCompletion() {
  const values = pods().filter((p) => p.spec.containers.some((c) => c.name === "tool-completion"));
  assert.equal(values.length, 1, "Reply fixture requires one Ready completion replica");
  return values[0];
}

/** Test-only preload over the maintained immutable image. The production server
 * has no fault flag; an ownership receipt precedes the temporary Pod template. */
export async function installOwnedReplyFault(receiptPath) {
  const deployment = readDeployment();
  assert.equal(deployment.spec.replicas, 1, "Reply fixture requires one completion replica");
  const serving = singleCompletion();
  const original = run(
    serving.metadata.name,
    `console.log(fs.readFileSync('${directory}/adapter.ts').toString('base64'));`,
  ).trim();
  const local = await readFile(join(repositoryRoot, "packages/cube-completion/src/adapter.ts"));
  assert.equal(
    digest(Buffer.from(original, "base64")),
    digest(local),
    "Serving completion image differs from checkout",
  );
  const fixtureId = randomUUID(),
    name = "pi-cloud-reply-fixture-" + fixtureId;
  const wrapper = await readFile(
    join(repositoryRoot, "scripts/fixtures/tool-reply-fault.mjs"),
    "utf8",
  );
  const preload = `import{CubeCompletionAdapter as Base}from '${directory}/adapter.ts';\nimport{wrapCompletionAdapter}from './fault.mjs';\nimport fs from 'node:fs';\nfs.writeFileSync('${config}',${JSON.stringify(JSON.stringify({ fixtureId, expiresAt: 0 }))},{mode:0o600});\nconst Wrapped=wrapCompletionAdapter(Base,'${config}','${state}');Base.prototype.accept=Wrapped.prototype.accept;\n`;
  const receipt = {
    version: 1,
    kind: "https-completion-fixture",
    fixtureId,
    configMap: name,
    deploymentUid: deployment.metadata.uid,
    originalTemplate: deployment.spec.template,
    originalSha256: digest(local),
    restored: false,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  try {
    kubectl(["apply", "-f", "-"], {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name },
        immutable: true,
        data: { "preload.mjs": preload, "fault.mjs": wrapper },
      }),
    });
    const template = structuredClone(deployment.spec.template);
    template.metadata.annotations = {
      ...template.metadata.annotations,
      "pi-cloud.io/reply-fixture": fixtureId,
    };
    template.spec.volumes.push({ name: "reply-fixture", configMap: { name, defaultMode: 292 } });
    const container = template.spec.containers.find((c) => c.name === "tool-completion");
    container.volumeMounts.push({ name: "reply-fixture", mountPath: mount, readOnly: true });
    container.command = [
      "node",
      "--import",
      "/app/node_modules/tsx/dist/loader.mjs",
      "--import",
      mount + "/preload.mjs",
    ];
    container.args = [directory + "/main.ts"];
    patchTemplate(template);
    receipt.installedTemplateSha256 = digest(readDeployment().spec.template);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    ready();
    const current = singleCompletion();
    receipt.pod = current.metadata.name;
    receipt.uid = current.metadata.uid;
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return receipt;
  } catch (error) {
    Object.defineProperty(error, "replyFaultReceipt", { value: receipt });
    throw error;
  }
}
export function armOwnedReplyFault(receipt, tenantId, marker, dropProbe, dropAck = false, device) {
  assert.match(tenantId, /^[0-9a-f-]{36}$/);
  if (device) {
    assert.match(device.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(device.toolName, "android_observe");
    assert.equal(device.defer, true);
  }
  const settings = {
    fixtureId: receipt.fixtureId,
    tenantId,
    marker,
    dropProbe,
    dropAck,
    ...(device ?? {}),
    nonce: randomUUID(),
    expiresAt: Date.now() + 10 * 60_000,
  };
  run(
    receipt.pod,
    `if(JSON.parse(fs.readFileSync('${config}','utf8')).fixtureId!==${JSON.stringify(receipt.fixtureId)})throw Error('Fixture owner changed');fs.writeFileSync('${config}',${JSON.stringify(JSON.stringify(settings))},{mode:0o600});`,
  );
  return settings.nonce;
}
export function disarmOwnedReplyFault(receipt) {
  run(
    receipt.pod,
    `if(JSON.parse(fs.readFileSync('${config}','utf8')).fixtureId!==${JSON.stringify(receipt.fixtureId)})throw Error('Fixture owner changed');fs.writeFileSync('${config}',${JSON.stringify(JSON.stringify({ fixtureId: receipt.fixtureId, expiresAt: 0 }))},{mode:0o600});`,
  );
}
export function readOwnedReplyFault(receipt) {
  return JSON.parse(
    run(
      receipt.pod,
      `console.log(fs.existsSync('${state}')?fs.readFileSync('${state}','utf8'):'null');`,
    ),
  );
}
export async function restoreOwnedReplyFault(receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.restored) return;
  assert.equal(receipt.kind, "https-completion-fixture", "Unknown restore receipt");
  const deployment = readDeployment();
  assert.equal(
    deployment.metadata.uid,
    receipt.deploymentUid,
    "Completion deployment was replaced",
  );
  if (
    deployment.spec.template.metadata.annotations?.["pi-cloud.io/reply-fixture"] ===
    receipt.fixtureId
  ) {
    if (receipt.installedTemplateSha256)
      assert.equal(
        digest(deployment.spec.template),
        receipt.installedTemplateSha256,
        "Completion template changed outside fixture",
      );
    patchTemplate(receipt.originalTemplate);
    ready();
  } else
    assert.equal(
      digest(deployment.spec.template),
      digest(receipt.originalTemplate),
      "Completion template no longer belongs to fixture",
    );
  const pod = singleCompletion();
  const source = run(
    pod.metadata.name,
    `console.log(fs.readFileSync('${directory}/adapter.ts').toString('base64'));`,
  ).trim();
  assert.equal(
    digest(Buffer.from(source, "base64")),
    receipt.originalSha256,
    "Restored completion source changed",
  );
  kubectl(["delete", "configmap", receipt.configMap, "--ignore-not-found"]);
  receipt.restored = true;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
