import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
import {
  S3ImageBlobStore,
  PostgresImageAttachmentStore,
} from "../packages/session-attachments/src/index.ts";

if (process.env.PI_CLOUD_LIVE_IMAGE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_IMAGE_CHECK=1 to permit Luna tokens, a disposable Cube and an idle Worker restart",
  );
const execFile = promisify(execFileCallback),
  runtime = "deploy/production/runtime";
const env = await readFile(`${runtime}/.env`, "utf8"),
  port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const api = new PiCloudApi(
  (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init),
  (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim(),
);
const address = (name) =>
  JSON.parse(
    execFileSync("docker", ["inspect", `pi-cloud-production-${name}-1`], { encoding: "utf8" }),
  )[0].NetworkSettings.Networks["pi-cloud-production_database"].IPAddress;
const pgurl = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pgurl.hostname = address("postgres");
const db = createDatabase({ connectionString: pgurl.toString(), maxConnections: 2 });
const blobs = new S3ImageBlobStore({
  endpoint: `http://${address("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(await readFile(`${runtime}/secrets/session-image-s3-credentials.json`, "utf8")),
});
const images = new PostgresImageAttachmentStore(db, blobs);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
  images: [],
};
let project, session, active, failure, stoppedWorkerService;
const pause = () => new Promise((r) => setTimeout(r, 250));
async function waitRun(id) {
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    const r = await api.getRun(id);
    if (["completed", "failed", "cancelled", "timed_out"].includes(r.state)) return r;
    await pause();
  }
  throw new Error("Image acceptance Run did not settle");
}
async function turn(prompt) {
  active = await api.acceptTurn(session.sessionId, prompt, newIdempotencyKey("image-check"), "low");
  const run = await waitRun(active.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const t = (await api.getConversation(session.sessionId)).turns.find((t) => t.runId === run.runId);
  assert(t?.transcript);
  report.runs.push({
    runId: run.runId,
    workerId: run.workerId,
    tools: t.transcript.items
      .filter((i) => i.kind === "tool")
      .map((i) => ({ name: i.toolName, status: i.status })),
  });
  return { run, transcript: t.transcript };
}
function generate(side) {
  return `node <<'IMAGE'
const sharp=require('/opt/pi-cloud/node_modules/sharp');
const fs=require('node:fs');const crypto=require('node:crypto');
(async()=>{const side=${side};const digits=String(crypto.randomInt(1000,10000));
const overlay=Buffer.from('<svg width="'+side+'" height="'+side+'"><rect x="'+side*.15+'" y="'+side*.32+'" width="'+side*.7+'" height="'+side*.36+'" fill="white"/><text x="'+side*.5+'" y="'+side*.60+'" text-anchor="middle" font-family="sans-serif" font-size="'+side*.18+'" font-weight="bold" fill="black">'+digits+'</text></svg>');
const png=await sharp(crypto.randomBytes(side*side*3),{raw:{width:side,height:side,channels:3}}).composite([{input:overlay}]).png().toBuffer();
fs.writeFileSync('/workspace/shot.png',png);
const old=fs.existsSync('/workspace/.image-check-expected.json')?JSON.parse(fs.readFileSync('/workspace/.image-check-expected.json','utf8')):[];old.push(digits);fs.writeFileSync('/workspace/.image-check-expected.json',JSON.stringify(old));
console.log('IMAGE_READY bytes='+png.length);})().catch(e=>{console.error(e.message);process.exitCode=1;});
IMAGE`;
}
try {
  project = await api.createProject(`Image attachment acceptance ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Image attachments",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  for (const [index, side] of [1600, 1600, 3200].entries()) {
    const detail = index === 2 ? "original" : "high";
    const { transcript } = await turn(
      `严格执行两次工具调用：先 bash 原样运行下面的命令，然后 read /workspace/shot.png（detail=${detail}）。必须实际看图。最后只回复 SEEN，不要说出图片数字，不要读取任何其他文件，不要搜索或子代理。\n${generate(side)}`,
    );
    const tools = transcript.items.filter((i) => i.kind === "tool");
    assert.deepEqual(
      tools.map((t) => t.toolName),
      ["bash", "read"],
    );
    for (const t of tools) assert.equal(t.status, "completed");
    assert(
      transcript.items
        .filter((i) => i.kind === "text")
        .map((i) => i.text)
        .join("")
        .includes("SEEN"),
    );
    const { rows } =
      await sql`select l.tenant_id, p.value as ref, octet_length(l.payload::text) as record_bytes from pi_session_log l,
      lateral jsonb_path_query(l.payload,'$.** ? (@.type == "pi_cloud_image_v1").attachment') p(value)
      where l.session_id=${session.sessionId} and l.payload->>'turnId'=${active.turnId}`.execute(
        db,
      );
    const refs = [...new Map(rows.map((r) => [r.ref.id, r])).values()];
    assert.equal(refs.length, 1);
    const row = refs[0];
    assert(row.ref.byteLength > 5 * 1024 * 1024);
    assert(Number(row.record_bytes) < 16384);
    const bytes = await images.get(row.tenant_id, row.ref);
    report.images.push({
      tenantId: row.tenant_id,
      ref: row.ref,
      recordBytes: Number(row.record_bytes),
      detail,
    });
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.ref.sha256);
  }
  assert.notEqual(report.images[0].ref.sha256, report.images[1].ref.sha256);
  // The source path was overwritten twice; the original immutable attachment survives.
  await images.get(report.images[0].tenantId, report.images[0].ref);
  const {
    rows: [counts],
  } =
    await sql`select count(*)::int n from runs where state in ('queued','running','settling','cancel_requested')`.execute(
      db,
    );
  assert.equal(counts.n, 0, "Another active Run prevents the Worker restart");
  const owner = report.runs.at(-1).workerId;
  const {
    rows: [old],
  } = await sql`select boot_id from sandboxes where id=${owner}::uuid`.execute(db);
  const {
    rows: [sandbox],
  } = await sql`select supervisor_id from sandboxes where id=${owner}::uuid`.execute(db);
  if (env.match(/^PI_CLOUD_PI_WORKER_DEPLOYMENT=(.*)$/m)?.[1] === "kubernetes") {
    await execFile(process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/kubectl", [
      "--kubeconfig",
      `${runtime}/kubernetes/pi-worker-local.kubeconfig`,
      "-n",
      "pi-cloud-workers",
      "delete",
      "pod",
      sandbox.supervisor_id,
      "--wait=true",
      "--timeout=120s",
    ]);
  } else {
    const prefix = env.match(/^PI_CLOUD_SUPERVISOR_ID_PREFIX=(.*)$/m)?.[1] ?? "pi-cloud-worker-";
    assert([prefix + "1", prefix + "2"].includes(sandbox.supervisor_id), "Unknown local Worker");
    stoppedWorkerService =
      sandbox.supervisor_id === prefix + "1" ? "supervisor-host" : "supervisor-host-1";
    await execFile(process.execPath, [
      "scripts/production-compose.mjs",
      "stop",
      stoppedWorkerService,
    ]);
  }
  const recalled = await turn(
    "不要调用任何工具、不要读取文件。只根据前面三张图片，按显示顺序输出三组四位数字，用逗号分隔。",
  );
  assert.equal(recalled.transcript.items.filter((i) => i.kind === "tool").length, 0);
  const answer = recalled.transcript.items
    .filter((i) => i.kind === "text")
    .map((i) => i.text)
    .join("")
    .trim();
  if (stoppedWorkerService) {
    await execFile(process.execPath, [
      "scripts/production-compose.mjs",
      "start",
      stoppedWorkerService,
    ]);
    stoppedWorkerService = undefined;
  }
  const expectedFile = await api.readWorkspaceFile(session.sessionId, ".image-check-expected.json");
  const digits = JSON.parse(Buffer.from(expectedFile.bytes).toString("utf8"));
  assert(Array.isArray(digits) && digits.length === 3 && digits.every((d) => /^\d{4}$/.test(d)));
  assert.deepEqual(answer.match(/\b\d{4}\b/g), digits);
  const {
    rows: [newOwner],
  } = await sql`select boot_id from sandboxes where id=${recalled.run.workerId}::uuid`.execute(db);
  assert(old.boot_id !== newOwner.boot_id || recalled.run.workerId !== owner);
  report.coldRecovery = {
    previousWorker: owner,
    nextWorker: recalled.run.workerId,
    changedBoot: old.boot_id !== newOwner.boot_id,
    visionRecallCorrect: true,
  };
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  try {
    if (stoppedWorkerService)
      await execFile(process.execPath, [
        "scripts/production-compose.mjs",
        "start",
        stoppedWorkerService,
      ]);
  } catch (e) {
    errors.push(e);
  }
  try {
    if (
      active &&
      session &&
      !["completed", "failed", "cancelled", "timed_out"].includes(
        (await api.getRun(active.runId)).state,
      )
    ) {
      await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("image-clean"));
      await waitRun(active.runId);
    }
  } catch (e) {
    errors.push(e);
  }
  try {
    if (session) await api.deleteConversation(session.sessionId, newIdempotencyKey("image-clean"));
  } catch (e) {
    errors.push(e);
  }
  try {
    if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("image-clean"));
  } catch (e) {
    errors.push(e);
  }
  report.cleanupCompleted = errors.length === 0;
  await writeFile(
    "docs/reports/image-attachments-live-20260926.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  blobs.close();
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Image attachment acceptance failed",
    );
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    images: report.images.map((i) => ({
      bytes: i.ref.byteLength,
      recordBytes: i.recordBytes,
      detail: i.detail,
    })),
    coldRecovery: report.coldRecovery,
    cleanupCompleted: report.cleanupCompleted,
  }),
);
