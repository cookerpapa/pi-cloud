import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { kubectl, repositoryRoot } from "./production-kubernetes.mjs";
import { join } from "node:path";

const directory = "/opt/pi-cloud/packages/cube-completion/src";
const target = `${directory}/adapter.ts`;
const backup = `${directory}/adapter.acceptance-original.ts`;
const wrapperFile = `${directory}/acceptance-reply-fault.mjs`;
const config = "/tmp/pi-cloud-tool-reply-fault.json";
const state = "/tmp/pi-cloud-tool-reply-fault-state.json";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const restartCompletion = `for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){
 try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
 if(Number(pid)!==process.pid&&args.includes('${directory}/main.ts'))process.kill(Number(pid),'SIGTERM');
 }catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}}
`;
const run = (pod, source) =>
  kubectl(["exec", "-i", pod, "-c", "cubelet", "--", "node", "--input-type=module", "-"], {
    input: `import fs from 'node:fs';import{createHash}from'node:crypto';const hash=v=>createHash('sha256').update(v).digest('hex');\n${source}`,
    timeout: 30000,
  });

export function singleReadyCubelet() {
  const pods = JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.filter(
    (p) =>
      !p.metadata.deletionTimestamp &&
      p.spec.containers.some((c) => c.name === "cubelet") &&
      p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
  );
  assert.equal(pods.length, 1, "Reply fault fixture requires one Ready Cubelet");
  return pods[0];
}

/** Install only after excluding unrelated work; restore receipt is written first. */
export async function installOwnedReplyFault(receiptPath) {
  const pod = singleReadyCubelet();
  const original = run(
    pod.metadata.name,
    `console.log(fs.readFileSync('${target}').toString('base64'));`,
  ).trim();
  const local = await readFile(join(repositoryRoot, "packages/cube-completion/src/adapter.ts"));
  assert.equal(
    digest(Buffer.from(original, "base64")),
    digest(local),
    "Serving adapter differs from this checkout",
  );
  const wrapper = await readFile(
    join(repositoryRoot, "scripts/fixtures/tool-reply-fault.mjs"),
    "utf8",
  );
  const entry = `import{CubeCompletionAdapter as Base}from './adapter.acceptance-original.ts';\nimport{wrapCompletionAdapter}from './acceptance-reply-fault.mjs';\nexport const CubeCompletionAdapter=wrapCompletionAdapter(Base,${JSON.stringify(config)},${JSON.stringify(state)});\n`;
  const receipt = {
    pod: pod.metadata.name,
    uid: pod.metadata.uid,
    fixtureId: randomUUID(),
    originalSha256: digest(local),
    wrapperSha256: digest(entry),
    restored: false,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  try {
    run(
      receipt.pod,
      `
if([${JSON.stringify(backup)},${JSON.stringify(wrapperFile)},${JSON.stringify(config)}].some(p=>fs.existsSync(p)))throw Error('Another reply fixture or unrestored files exist');
if(hash(fs.readFileSync('${target}'))!==${JSON.stringify(receipt.originalSha256)})throw Error('Adapter changed');
fs.writeFileSync('${config}',${JSON.stringify(JSON.stringify({ fixtureId: receipt.fixtureId, expiresAt: 0 }))},{flag:'wx',mode:0o600});
fs.copyFileSync('${target}','${backup}',fs.constants.COPYFILE_EXCL);
fs.writeFileSync('${wrapperFile}',${JSON.stringify(wrapper)},{flag:'wx',mode:0o600});
fs.writeFileSync('${target}',${JSON.stringify(entry)});
${restartCompletion}
`,
    );
  } catch (error) {
    error.replyFaultReceipt = receipt;
    throw error;
  }
  return receipt;
}

export function armOwnedReplyFault(receipt, tenantId, marker, dropProbe) {
  assert.match(tenantId, /^[0-9a-f-]{36}$/);
  const settings = {
    fixtureId: receipt.fixtureId,
    tenantId,
    marker,
    dropProbe,
    nonce: randomUUID(),
    expiresAt: Date.now() + 10 * 60_000,
  };
  run(
    receipt.pod,
    `if(JSON.parse(fs.readFileSync('${config}','utf8')).fixtureId!==${JSON.stringify(receipt.fixtureId)})throw Error('Fixture owner changed');fs.writeFileSync('${config}',${JSON.stringify(JSON.stringify(settings))},{mode:0o600});`,
  );
  return settings.nonce;
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
  const pod = singleReadyCubelet();
  if (pod.metadata.uid === receipt.uid)
    run(
      receipt.pod,
      `
if(!fs.existsSync('${config}')&&[${JSON.stringify(backup)},${JSON.stringify(wrapperFile)}].some(p=>fs.existsSync(p)))throw Error('Fixture ownership record missing');
if(fs.existsSync('${config}')&&JSON.parse(fs.readFileSync('${config}','utf8')).fixtureId!==${JSON.stringify(receipt.fixtureId)})throw Error('Fixture owner changed');
const actual=hash(fs.readFileSync('${target}'));
if(![${JSON.stringify(receipt.wrapperSha256)},${JSON.stringify(receipt.originalSha256)}].includes(actual))throw Error('Adapter changed outside fixture');
if(actual!==${JSON.stringify(receipt.originalSha256)}){
 if(hash(fs.readFileSync('${backup}'))!==${JSON.stringify(receipt.originalSha256)})throw Error('Original adapter changed');
 fs.copyFileSync('${backup}','${target}');
}
${restartCompletion}
for(const path of ${JSON.stringify([backup, wrapperFile, config, state])})if(fs.existsSync(path))fs.unlinkSync(path);
if(hash(fs.readFileSync('${target}'))!==${JSON.stringify(receipt.originalSha256)})throw Error('Restore checksum mismatch');
`,
    );
  else {
    const restoredHash = run(
      pod.metadata.name,
      `console.log(hash(fs.readFileSync('${target}')));`,
    ).trim();
    assert.equal(restoredHash, receipt.originalSha256, "Replacement Cubelet adapter changed");
  }
  receipt.restored = true;
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}
