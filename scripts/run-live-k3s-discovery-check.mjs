import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import {
  kubectl,
  kubectlAsync,
  podFor,
  serviceAddress,
  execIn,
  runtimeDirectory,
  runtimeEnvironment,
  workload,
} from "./lib/production-kubernetes.mjs";
if (process.env.PI_CLOUD_LIVE_K3S_DISCOVERY_CHECK !== "1")
  throw Error(
    "Set PI_CLOUD_LIVE_K3S_DISCOVERY_CHECK=1 for real Luna and infrastructure Pod replacement acceptance",
  );
const env = runtimeEnvironment();
const token = (await readFile(`${runtimeDirectory}/secrets/api-token`, "utf8")).trim();
const api = new PiCloudApi(
  (path, init) => fetch(new URL(String(path), `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`), init),
  token,
);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  replacements: [],
  runs: [],
};
let project, session, active, failure;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause(500);
  }
  throw Error(`Timed out: ${label}`);
}
function assertIdle() {
  assert.equal(
    execIn("postgres", [
      "psql",
      "-U",
      "pi_cloud",
      "-d",
      "pi_cloud",
      "-Atc",
      "select count(*) from runs where state in ('queued','running','settling','cancel_requested')",
    ]).trim(),
    "0",
    "Infrastructure replacement requires zero active Runs",
  );
}
function cubelet() {
  const pod = JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.find(
    (p) => !p.metadata.deletionTimestamp && p.spec.containers.some((c) => c.name === "cubelet"),
  );
  assert(pod);
  const status = pod.status.containerStatuses.find((c) => c.name === "cubelet");
  return {
    podUid: pod.metadata.uid,
    containerId: status.containerID,
    restartCount: status.restartCount,
  };
}
// Deterministic 64x64 RGB fixture, generated from raw pixels; no user image data.
function png() {
  function crc(bytes) {
    let n = 0xffffffff;
    for (const b of bytes) {
      n ^= b;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type),
      size = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([size, t, data, sum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + 2] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function turn(prompt) {
  active = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("k3s-discovery"),
    "low",
  );
  const run = await until(
    async () => {
      const value = await api.getRun(active.runId);
      return ["completed", "failed", "cancelled", "timed_out"].includes(value.state)
        ? value
        : undefined;
    },
    "Run completion",
    600000,
  );
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const t = (await api.getConversation(session.sessionId)).turns.find((t) => t.runId === run.runId);
  report.runs.push({
    runId: run.runId,
    state: run.state,
    tools: t.transcript.items
      .filter((i) => i.kind === "tool")
      .map((i) => ({ name: i.toolName, state: i.status })),
  });
  return t;
}
try {
  assertIdle();
  const before = cubelet();
  project = await api.createProject(`K3s discovery ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "K3s discovery",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  const upload = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob([png()], { type: "image/png" }),
    "blue.png",
  );
  await turn(
    `用 bash 执行 printf 'ONCE\\n' > /workspace/k3s-once.txt。然后用 read 读取图片 ${upload.path}，只回复图片的颜色。不要子代理。`,
  );
  assertIdle();
  for (const service of ["postgres", "kafka-1", "kafka-2", "kafka-3", "session-images"]) {
    const clusterIP = serviceAddress(service),
      old = JSON.parse(kubectl(["get", "pod", podFor(service), "-o", "json"]));
    await kubectlAsync(["delete", "pod", old.metadata.name, "--wait=true", "--timeout=180s"]);
    await kubectlAsync(["rollout", "status", workload(service), "--timeout=180s"]);
    const current = JSON.parse(kubectl(["get", "pod", podFor(service), "-o", "json"]));
    assert.notEqual(current.metadata.uid, old.metadata.uid);
    assert.notEqual(current.status.podIP, old.status.podIP);
    assert.equal(serviceAddress(service), clusterIP);
    report.replacements.push({
      service,
      clusterIP,
      previousPodIP: old.status.podIP,
      podIP: current.status.podIP,
    });
  }
  const management = (
    await readFile(`${runtimeDirectory}/secrets/supervisor-management-token`, "utf8")
  ).trim();
  await until(async () => {
    const r = await fetch(
      `http://${serviceAddress("control-plane")}:3000/internal/v1/session-publication/health`,
      { headers: { authorization: `Bearer ${management}` }, signal: AbortSignal.timeout(3000) },
    );
    return (
      r.ok && (await r.json()).partitions.length === Number(env.PI_CLOUD_KAFKA_PARTITIONS ?? 32)
    );
  }, "publication partitions reconnect");
  const after = await turn(
    `用 read 重新读取图片 ${upload.path}，只根据图片判断主色。再用 bash 执行 cat /workspace/k3s-once.txt，确认恰好一行 ONCE；不要写入或重做之前的命令。最后回答 BLUE 和文件校验结果。`,
  );
  const text = after.transcript.items
    .filter((i) => i.kind === "text")
    .map((i) => i.text)
    .join("");
  assert.match(text, /BLUE/i);
  assert.equal(
    Buffer.from((await api.readWorkspaceFile(session.sessionId, "k3s-once.txt")).bytes).toString(),
    "ONCE\n",
  );
  assert.deepEqual(cubelet(), before, "Reconnection must not replace the Cubelet/completion host");
  report.cubeletUnchanged = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const cleanup of [
    async () => {
      if (active) {
        const run = await api.getRun(active.runId);
        if (!["completed", "failed", "cancelled", "timed_out"].includes(run.state)) {
          await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cleanup"));
          await until(
            async () =>
              ["completed", "failed", "cancelled", "timed_out"].includes(
                (await api.getRun(active.runId)).state,
              ),
            "cancel completion",
          );
        }
      }
    },
    async () => {
      if (session) await api.deleteConversation(session.sessionId);
    },
    async () => {
      if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
    },
  ])
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  report.cleanupCompleted = errors.length === 0;
  await writeFile(
    `${runtimeDirectory}/k3s/discovery-acceptance.json`,
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "K3s discovery acceptance failed",
    );
}
console.log(JSON.stringify(report));
