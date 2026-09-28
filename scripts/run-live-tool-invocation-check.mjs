import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { ACCEPTED_FACT_TOPIC } from "../packages/event-log/src/index.ts";
import { toolCommandForFact } from "../packages/runtime-core/src/tool-invocation-fact.ts";

if (process.env.PI_CLOUD_LIVE_TOOL_INVOCATION_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_TOOL_INVOCATION_CHECK=1 for real Luna/Cube and a controlled Projector restart",
  );
const exec = promisify(execFile);
const port = (await readFile("deploy/production/runtime/.env", "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port);
const token = (await readFile("deploy/production/runtime/secrets/api-token", "utf8")).trim();
const api = new PiCloudApi(
  (input, init) => fetch(new URL(String(input), `http://127.0.0.1:${port}`), init),
  token,
);
const report = {
  checkedAt: new Date().toISOString(),
  revision: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  model: "gpt-6-luna",
  accepted: false,
};
const compose = (args) =>
  exec(process.execPath, ["scripts/production-compose.mjs", ...args], {
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
const query = async (sql) =>
  JSON.parse(
    (
      await exec("docker", [
        "exec",
        "pi-cloud-production-postgres-1",
        "psql",
        "-U",
        "pi_cloud",
        "-d",
        "pi_cloud",
        "-X",
        "-A",
        "-t",
        "-c",
        sql,
      ])
    ).stdout.trim(),
  );
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(action, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
const waitRun = (id) =>
  until(
    async () => {
      const run = await api.getRun(id);
      return terminal(run) ? run : undefined;
    },
    "Run closure",
    600000,
  );

// Read-only evidence consumer. Never prints or retains other Sessions' payloads.
async function auditKafka(runIds) {
  const wanted = new Set(runIds);
  const rows = new Map(
    runIds.map((id) => [
      id,
      { runId: id, invocations: [], standaloneCommands: 0, separateFixedIntents: 0 },
    ]),
  );
  const assistants = new Set();
  const child = spawn(
    "docker",
    [
      "exec",
      "pi-cloud-production-kafka-1-1",
      "/opt/kafka/bin/kafka-console-consumer.sh",
      "--bootstrap-server",
      "kafka-1:9092",
      "--topic",
      ACCEPTED_FACT_TOPIC,
      "--from-beginning",
      "--timeout-ms",
      "3000",
      "--consumer-property",
      "enable.auto.commit=false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  for await (const line of createInterface({ input: child.stdout })) {
    const fact = JSON.parse(line);
    const row = rows.get(fact.scope?.runId);
    if (!row || !wanted.has(fact.scope.runId)) continue;
    if (fact.kind === "tool_command") row.standaloneCommands++;
    for (const item of fact.items ?? []) {
      if (
        item.kind === "entry" &&
        item.entry.type === "message" &&
        item.entry.message.role === "assistant"
      )
        assistants.add(item.entry.id);
      if (
        fact.kind === "pi_session_append" &&
        item.kind === "record" &&
        item.record.type === "tool_started" &&
        ["read", "write", "edit", "bash"].includes(item.record.toolName)
      )
        row.separateFixedIntents++;
    }
    if (fact.kind === "tool_invocation") {
      const intent = fact.items[0].record;
      assert(
        assistants.has(intent.assistantEntryId),
        "Tool preceded its complete Assistant checkpoint",
      );
      const command = toolCommandForFact(fact);
      assert.equal(command.toolCallId, intent.resultEntryId);
      row.invocations.push({
        operationId: command.request.operationId,
        toolName: command.request.toolName,
        resultEntryId: intent.resultEntryId,
        nativeSequence: intent.seq,
        kafkaBytes: Buffer.byteLength(line),
      });
    }
  }
  const code = await closed;
  assert(code === 0 || diagnostics.includes("TimeoutException"), "Kafka evidence consumer failed");
  for (const row of rows.values()) {
    assert(row.invocations.length > 0, "Missing combined invocation evidence");
    assert.equal(row.standaloneCommands, 0);
    assert.equal(row.separateFixedIntents, 0);
    assert.equal(
      new Set(row.invocations.map((item) => item.operationId)).size,
      row.invocations.length,
    );
  }
  return [...rows.values()];
}

let project,
  session,
  active,
  restartNeeded = false,
  failure;
try {
  assert.equal(
    await query(
      "SELECT count(*)::int FROM runs WHERE state NOT IN ('completed','failed','cancelled','timed_out')",
    ),
    0,
    "Other Runs must drain before the controlled restart",
  );
  project = await api.createProject(`Atomic invocation ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Atomic Tool restart",
    "elastic",
    "starter",
    "/workspace",
    {
      provider: "openai-codex",
      modelId: report.model,
      thinkingLevel: "low",
      fastMode: false,
    },
  );
  report.resources = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  const command =
    'python3 -c \'import os,time; f=open("dispatch-count.txt","a"); f.write("once\\n"); f.flush(); os.fsync(f.fileno()); f.close(); print("EFFECT_STARTED",flush=True); time.sleep(40); print("EFFECT_COMPLETED")\'';
  active = await api.acceptTurn(
    session.sessionId,
    `Call bash exactly once with this exact command and wait for its final result: ${command}\nDo not delegate, search, retry or call other tools. Then briefly report the actual result.`,
    newIdempotencyKey("atomic-invocation"),
    "low",
  );
  report.runId = active.runId;
  await until(async () => {
    try {
      return (
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "dispatch-count.txt")).bytes,
        ).toString() === "once\n"
      );
    } catch {
      return false;
    }
  }, "first actual guest effect");
  const count = await query(
    "SELECT count(*)::int FROM runs WHERE state NOT IN ('completed','failed','cancelled','timed_out')",
  );
  assert.equal(count, 1, "Another Run started; refusing an unrelated restart");
  report.restartStartedAt = new Date().toISOString();
  restartNeeded = true;
  await compose(["kill", "--signal", "SIGKILL", "control-plane"]);
  await compose(["start", "--wait", "control-plane"]);
  restartNeeded = false;
  report.restartCompletedAt = new Date().toISOString();
  const run = await waitRun(active.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const body = Buffer.from(
    (await api.readWorkspaceFile(session.sessionId, "dispatch-count.txt")).bytes,
  ).toString();
  assert.equal(body, "once\n", "Replayed projection repeated the shell effect");
  const turn = (await api.getConversation(session.sessionId)).turns.find(
    (item) => item.runId === active.runId,
  );
  const tools = turn.transcript.items.filter((item) => item.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[0].input.command, command);
  assert(JSON.stringify(tools[0].output).includes("EFFECT_COMPLETED"));
  report.effectCount = body.trim().split("\n").length;
  const prior = process.env.PI_CLOUD_LIVE_NATIVE_TOOL_REPORT
    ? JSON.parse(await readFile(process.env.PI_CLOUD_LIVE_NATIVE_TOOL_REPORT, "utf8"))
    : undefined;
  if (prior) assert(prior.accepted && prior.model === report.model);
  report.kafka = await auditKafka([...(prior?.runs.map((item) => item.runId) ?? []), active.runId]);
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  if (restartNeeded) {
    try {
      await compose(["start", "--wait", "control-plane"]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (active && session) {
    try {
      if (!terminal(await api.getRun(active.runId))) {
        await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("atomic-cancel"));
        await waitRun(active.runId);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (session) {
    try {
      await api.deleteConversation(session.sessionId, newIdempotencyKey("atomic-session"));
    } catch (error) {
      errors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("atomic-workspace"));
    } catch (error) {
      errors.push(error);
    }
  }
  report.cleanupCompleted = errors.length === 0;
  await writeFile(
    process.env.PI_CLOUD_LIVE_TOOL_INVOCATION_REPORT ??
      "docs/reports/tool-invocation-live-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      runId: report.runId,
      effectCount: report.effectCount,
      cleanupCompleted: report.cleanupCompleted,
    }),
  );
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Atomic Tool invocation acceptance failed",
    );
}
