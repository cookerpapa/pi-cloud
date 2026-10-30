import { serviceAddress } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { createSession } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDatabase } from "../packages/database/src/index.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "../packages/pi-session-postgres/src/durable/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_INDEXED_LOG_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_INDEXED_LOG_CHECK=1 for Luna/Cube and an owned cold-compaction fixture",
  );
const runtime = "deploy/production/runtime";
const environment = await readFile(`${runtime}/.env`, "utf8");
const port = environment.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const api = new PiCloudApi(
  (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init),
  (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim(),
);
const url = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  checkedAt: new Date().toISOString(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
  compactionMethod:
    "Seed one native Compaction through the quiescent Storage port; verify real Luna cold reads. This is not an automatic-threshold or model-summary-generation benchmark.",
};
let project, source, fork, failure;
const accepted = [];
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(read, predicate, description, milliseconds = 600000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}
async function run(sessionId, prompt) {
  const task = await api.acceptTurn(
    sessionId,
    prompt,
    newIdempotencyKey("indexed-log-live"),
    "low",
  );
  accepted.push({ sessionId, ...task });
  const result = await until(() => api.getRun(task.runId), terminal, "Run settlement");
  assert.equal(result.state, "completed", "Live Run failed");
  const conversation = await api.getConversation(sessionId);
  const turn = conversation.turns.find((turn) => turn.runId === task.runId);
  assert(turn?.transcript);
  report.runs.push({
    runId: task.runId,
    turnId: task.turnId,
    sessionId,
    workerId: result.workerId,
    tools: turn.transcript.items
      .filter((item) => item.kind === "tool")
      .map((item) => ({ name: item.toolName, state: item.status })),
  });
  console.log(JSON.stringify(report.runs.at(-1)));
  return { task, transcript: turn.transcript };
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const retired = await sql`select count(*)::int as remaining
    from information_schema.tables where table_schema='public' and table_name in
      ('pi_session_entries','pi_session_records','pi_session_entry_refs','pi_session_visible_entries')`.execute(
    db,
  );
  assert.equal(retired.rows[0].remaining, 0);
  project = await api.createProject(`Indexed log ${Date.now()}`);
  source = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Indexed log",
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
  const selectedModel = await api.getSessionModel(source.sessionId);
  assert.equal(selectedModel.provider, "openai-codex");
  assert.equal(selectedModel.modelId, report.model);
  report.resources = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sourceSessionId: source.sessionId,
  };
  const first = await run(
    source.sessionId,
    "请实际执行：write 创建 indexed_log.txt，内容为 INDEXED_LOG_FILE_OK；read 读取确认；bash 执行 test -f indexed_log.txt。然后用 subagent 创建且只创建一个 fresh 子任务，让它不使用任何工具，回复 CHILD_LOG_OK；等待它结束。不要搜索或创建更多子任务。全部成功后简短报告。所有模型使用当前继承的 GPT-6 Luna。",
  );
  for (const name of ["write", "read", "bash", "subagent"])
    assert(
      report.runs[0].tools.some((tool) => tool.name === name && tool.state === "completed"),
      `Missing ${name}`,
    );
  const scope = await db
    .selectFrom("sessions")
    .select(["tenant_id", "pi_session_id"])
    .where("id", "=", source.sessionId)
    .executeTakeFirstOrThrow();
  const children = await db
    .selectFrom("subagent_executions as child")
    .innerJoin("sessions as session", "session.id", "child.child_session_id")
    .select([
      "child.id",
      "child.state",
      "child.root_run_id as run_id",
      "child.child_turn_id as turn_id",
      "session.pi_session_id",
      "session.desired_model_profile_id",
    ])
    .where("child.tenant_id", "=", scope.tenant_id)
    .where("child.root_run_id", "=", first.task.runId)
    .execute();
  assert.equal(children.length, 1);
  assert.equal(children[0].state, "completed");
  assert.equal(children[0].pi_session_id, scope.pi_session_id);
  const childModel = await db
    .selectFrom("model_profiles")
    .select("model_id")
    .where("id", "=", children[0].desired_model_profile_id)
    .executeTakeFirstOrThrow();
  assert.equal(childModel.model_id, report.model);
  report.child = {
    runId: children[0].run_id,
    samePhysicalSession: true,
    completed: true,
    model: childModel.model_id,
  };
  await until(
    async () =>
      (
        await db
          .selectFrom("session_leases")
          .select("lease_id")
          .where("pi_session_id", "=", scope.pi_session_id)
          .where("released_at", "is", null)
          .execute()
      ).length,
    (count) => count === 0,
    "ordered Session closure",
    120000,
  );
  const leaf = await db
    .selectFrom("pi_durable_records")
    .select("id")
    .where("tenant_id", "=", scope.tenant_id)
    .where("session_id", "=", scope.pi_session_id)
    .where("kind", "=", sql.lit("entry"))
    .where(sql`fields->>'turn'`, "=", first.task.turnId)
    .where(sql`fields->>'role'`, "=", "assistant")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
  fork = await api.forkConversation(
    source.sessionId,
    first.task.turnId,
    leaf.id,
    "Indexed-log Fork",
    newIdempotencyKey("indexed-log-fork"),
  );
  report.resources.forkSessionId = fork.session.sessionId;
  assert.equal(
    digest(
      (await api.getConversation(source.sessionId)).turns.find(
        (turn) => turn.runId === first.task.runId,
      ).transcript,
    ),
    digest(first.transcript),
  );
  const marker = `COMPACTED-${randomUUID()}`;
  // This unowned fork is an administrative cold-read fixture. Generic Session
  // owns entry/head stamping; no Harness or model runs in the control plane.
  const compaction = await db.transaction().execute(async (tx) => {
    const projection = new DurablePostgresProjection(
      tx,
      { tenantId: scope.tenant_id, sessionId: fork.session.sessionId },
      undefined,
      "references",
    );
    const native = await PublishedDurableStorage.open({
      projection,
      publish: (batch) => projection.applyIn(tx, batch).then(() => {}),
      waitProjected: async () => {},
    });
    const session = createSession(native);
    try {
      const entry = await session.commit(
        (change) =>
          change.appendEntry(1, {
            kind: "pi.compaction",
            head: "self",
            data: { reason: "manual" },
            model: [
              {
                role: "user",
                timestamp: Date.now(),
                content: `Storage acceptance context: exact marker ${marker}. Workspace contains indexed_log.txt with INDEXED_LOG_FILE_OK. One Child completed CHILD_LOG_OK.`,
              },
            ],
          }),
        BACKGROUND_CONTEXT,
      );
      assert.equal(
        (await native.findLatestHeadMarker(1, undefined, BACKGROUND_CONTEXT)).entry.id,
        entry.id,
      );
      return entry;
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  });
  const resumed = await run(
    fork.session.sessionId,
    "先 read 读取已有 indexed_log.txt。然后输出压缩摘要中的完整 COMPACTED- 开头验证标记，并确认文件内容。标记只在此前上下文的摘要里，不要用其他工具或子代理寻找，也不要搜索。",
  );
  const response = resumed.transcript.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("");
  assert(response.includes(marker), "Cold model context omitted the native Compaction");
  assert(
    report.runs.at(-1).tools.some((tool) => tool.name === "read" && tool.state === "completed"),
  );
  assert.equal(
    Buffer.from((await api.readWorkspaceFile(fork.session.sessionId, "indexed_log.txt")).bytes)
      .toString("utf8")
      .trim(),
    "INDEXED_LOG_FILE_OK",
  );
  const open = await db
    .selectFrom("pi_durable_records")
    .select("seq")
    .where("tenant_id", "=", scope.tenant_id)
    .where("session_id", "in", [scope.pi_session_id, fork.session.sessionId])
    .where("kind", "=", "task")
    .where(sql`fields->>'status'`, "!=", "terminal")
    .execute();
  assert.equal(open.length, 0);
  report.compaction = {
    entryId: compaction.id,
    selectedSeedEntries: 1,
    coldLunaRecall: true,
  };
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const task of accepted) {
    try {
      if (!terminal(await api.getRun(task.runId))) {
        await api.cancelTurn(task.sessionId, task.turnId, newIdempotencyKey("indexed-log-clean"));
        await until(() => api.getRun(task.runId), terminal, "cancelled fixture", 120000);
      }
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  }
  try {
    if (source) await api.deleteConversation(source.sessionId);
    if (fork) await api.deleteConversation(fork.session.sessionId);
  } catch (error) {
    cleanupErrors.push(error.message);
  }
  try {
    if (project)
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("indexed-log-clean"));
  } catch (error) {
    cleanupErrors.push(error.message);
  }
  report.cleanupCompleted = cleanupErrors.length === 0;
  if (failure || cleanupErrors.length) {
    report.accepted = false;
    report.failure = failure?.message ?? "Fixture cleanup failed";
  }
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-indexed-log-live.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await db.destroy();
  if (failure) throw failure;
  if (cleanupErrors.length) throw new Error("Indexed-log fixture cleanup failed");
}
