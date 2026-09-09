import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { kafkaProducerLane } from "../packages/runtime-core/src/kafka-accepted-fact.ts";
import { ACCEPTED_FACT_TOPIC } from "@pi-cloud/event-log";

if (process.env.PI_CLOUD_LIVE_TOOL_SHARD_CHECK !== "1")
  throw new Error("Opt in to real model/Cube usage with PI_CLOUD_LIVE_TOOL_SHARD_CHECK=1");
// Run with a second Broker on production's existing domain/group. Its current
// assignment is independently checked with kafka-consumer-groups --members.
const replica =
  process.env.PI_CLOUD_TEST_BROKER_CONTAINER ?? "pi-cloud-tool-broker-shard-acceptance";
const exec = promisify(execFile),
  sessions = [];
const env = Object.fromEntries(
  (await readFile("deploy/production/runtime/.env", "utf8"))
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`,
  suffix = Date.now().toString(36),
  username = `shard.check.${suffix}`;
let cookie = "",
  workspace,
  session;
const fetchApi = async (path, init = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...(cookie ? { cookie } : {}) },
  });
  for (const c of response.headers.getSetCookie())
    if (c.startsWith("pi_cloud_session=")) cookie = c.split(";")[0];
  return response;
};
const api = new PiCloudApi(fetchApi);
const sql = async (query) =>
  (
    await exec("docker", [
      "exec",
      "pi-cloud-production-postgres-1",
      "psql",
      "-U",
      "pi_cloud",
      "-d",
      "pi_cloud",
      "-Atc",
      query,
    ])
  ).stdout.trim();
async function metrics() {
  const code = `const t=require('node:fs').readFileSync(process.env.PI_CLOUD_METRICS_TOKEN_FILE,'utf8').trim();fetch('http://127.0.0.1:9466/metrics',{headers:{authorization:'Bearer '+t}}).then(r=>{if(!r.ok)throw Error('metrics');return r.text()}).then(t=>console.log(t))`;
  const text = (await exec("docker", ["exec", replica, "node", "-e", code])).stdout;
  const sample = (name) =>
    text
      .split("\n")
      .filter(
        (l) =>
          l.startsWith(name + "{") &&
          l.includes('route="remote"') &&
          l.includes('outcome="delivered"'),
      )
      .reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);
  return {
    count: sample("pi_cloud_tool_log_delivery_seconds_count"),
    seconds: sample("pi_cloud_tool_log_delivery_seconds_sum"),
  };
}
const report = { accepted: false, checkedAt: new Date().toISOString(), runs: [] },
  abort = new AbortController();
let stream;
try {
  const owner = (
    await sql(
      `select instance_id || '|' || sandbox_domain_id from tool_broker_instances where state='ready' and owner_base_url='http://${replica.replaceAll("'", "''")}:4300/'`,
    )
  ).split("|");
  assert(owner.length === 2, "Start a second Broker and set PI_CLOUD_TEST_BROKER_CONTAINER");
  const membership = (
    await exec("docker", [
      "exec",
      "pi-cloud-production-kafka-1-1",
      "/opt/kafka/bin/kafka-consumer-groups.sh",
      "--bootstrap-server",
      "kafka-1:9092",
      "--describe",
      "--group",
      `pi-cloud-tool-dispatch-${owner[1]}`,
      "--members",
      "--verbose",
    ])
  ).stdout;
  const assignments = membership
    .split("\n")
    .filter((l) => l.includes(`${ACCEPTED_FACT_TOPIC}:`))
    .map((line) => ({
      line,
      partitions: line.split(`${ACCEPTED_FACT_TOPIC}:`)[1].split(/\s/)[0].split(",").map(Number),
    }));
  const assigned = new Set(
    assignments.find((a) => a.line.includes(`tool-router-${owner[0]}`))?.partitions,
  );
  const partitionCount = 1 + Math.max(...assignments.flatMap((a) => a.partitions));
  assert(
    assigned.size > 0 && assigned.size < partitionCount,
    "The test requires two Ready partition owners",
  );
  await api.registerAccount(username, "Broker sharding acceptance", `Shard ${suffix} !9`);
  workspace = await api.createProject(`Shard check ${suffix}`);
  // Select a partition currently owned by the remote router, not a guessed half.
  for (let i = 0; i < 16; i++) {
    const candidate = await api.createSession(
      workspace.projectId,
      workspace.workspaceId,
      `Shard check ${suffix} ${i}`,
      "elastic",
      "starter",
      "/workspace",
      { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off", fastMode: false },
    );
    sessions.push(candidate);
    const nativeId = await sql(
      `select pi_session_id from sessions where id='${candidate.sessionId}'`,
    );
    if (assigned.has(kafkaProducerLane(nativeId, partitionCount))) {
      session = candidate;
      report.partition = kafkaProducerLane(nativeId, partitionCount);
      break;
    }
  }
  assert(session, "No Session mapped to the remote router assignment");
  const events = [];
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: abort.signal,
    fetchImplementation: fetchApi,
    onStatus() {},
    onSnapshot() {},
    onEvent: (event) => events.push({ event, at: Date.now() }),
  });
  const before = await metrics();
  for (const prompt of [
    "用 write 创建 algorithms.py，包含插入排序、二分查找和 unittest，覆盖空数组、重复值、负数、未命中。用 bash 运行 python3 algorithms.py，确认测试通过。不要使用子代理或搜索。",
    "先用 read 读取 algorithms.py，保留现有实现和测试，再用 edit 增加归并排序和随机数组测试，最后 bash 运行 python3 algorithms.py。不要使用子代理或搜索。",
  ]) {
    const start = Date.now(),
      accepted = await api.acceptTurn(
        session.sessionId,
        prompt,
        newIdempotencyKey("shard-coding"),
        "off",
      );
    let run;
    for (let i = 0; i < 1200; i++) {
      run = await api.getRun(accepted.runId);
      if (["completed", "failed", "cancelled", "timed_out"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(run?.state, "completed", JSON.stringify(run?.failure));
    const used = events.filter((e) => e.event.turnId === accepted.turnId);
    const toolEvents = used.filter((e) => e.event.type === "tool.completed");
    assert(toolEvents.length >= 2);
    const first = used.find((e) => e.event.type === "assistant.text.delta");
    report.runs.push({
      elapsedMs: Date.now() - start,
      firstTextMs: first ? first.at - start : null,
      completedTools: toolEvents.length,
    });
  }
  const after = await metrics();
  assert(after.count > before.count, "The coding task did not traverse the remote Broker RPC");
  report.remoteDeliveries = after.count - before.count;
  report.remoteAdmissionMeanMs =
    ((after.seconds - before.seconds) * 1000) / report.remoteDeliveries;
  report.usage = JSON.parse(
    await sql(
      `select json_build_object('requests',count(*),'input',coalesce(sum((e.payload#>>'{message,usage,input}')::bigint),0),'output',coalesce(sum((e.payload#>>'{message,usage,output}')::bigint),0),'cacheRead',coalesce(sum((e.payload#>>'{message,usage,cacheRead}')::bigint),0)) from pi_session_entries e join sessions s on s.pi_session_id=e.session_id and s.tenant_id=e.tenant_id where s.id='${session.sessionId}' and e.payload#>>'{message,role}'='assistant'`,
    ),
  );
  assert(report.usage.output > 0);
  report.accepted = true;
} finally {
  abort.abort();
  await stream?.catch(() => {});
  for (const s of sessions)
    await api.deleteConversation(s.sessionId, newIdempotencyKey("delete-shard-session"));
  if (workspace)
    await api.deleteWorkspace(workspace.workspaceId, newIdempotencyKey("delete-shard-workspace"));
}
report.resourcesReleased = true;
await writeFile(
  "docs/reports/tool-command-sharding-live-latest.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({ ...report, cleanupUsername: username }));
