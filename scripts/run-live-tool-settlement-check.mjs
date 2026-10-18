import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_TOOL_SETTLEMENT_CHECK !== "1")
  throw Error(
    "Set PI_CLOUD_LIVE_TOOL_SETTLEMENT_CHECK=1 for owned Luna/Cube coordination fixtures",
  );
const output = resolve(process.argv[2] ?? "/tmp/pi-cloud-tool-settlement.json");
const pg = new URL((await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim());
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const base = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  checkedAt: new Date().toISOString(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  cases: [],
};
let tenant, api, project, session, failure, blobs;
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(label + " timed out");
}
async function settled(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r) && r;
  }, "Run settlement");
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "Native seal");
  return run;
}
async function run(prompt) {
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("settlement"),
    "low",
  );
  assert.equal(accepted.kind, "run");
  const finished = await settled(accepted.runId);
  assert.equal(finished.state, "completed", finished.failure?.code ?? "Run failed");
  return {
    runId: accepted.runId,
    messages: nativeMessages(await nativeHistory(db, { runId: accepted.runId })),
  };
}
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-" + randomUUID(),
    ownerDisplayName: "Native Tool settlement acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Native Tool settlement acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Native Tool settlement",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const c of [
    {
      name: "complete-json",
      script: 'return {body:"x".repeat(48000),end:"COMPLETE_JSON"};',
      error: false,
    },
    {
      name: "byte-overflow",
      script:
        'const fs=await import("node:fs");fs.appendFileSync("byte-marker","once\\n");return "x".repeat(51201);',
      error: true,
      marker: "byte-marker",
    },
    {
      name: "line-overflow",
      script:
        'const fs=await import("node:fs");fs.appendFileSync("line-marker","once\\n");return "line\\n".repeat(2001);',
      error: true,
      marker: "line-marker",
    },
  ]) {
    console.log(JSON.stringify({ phase: c.name }));
    const result = await run(
      "严格只调用一次 subagent 工具，action 为 workflow，script 必须逐字使用下面代码。不要启动子 Agent，不要使用其他工具，也不要重试。工具结束后无论成功或报错，只回复 CHECKED，不要复述返回数据。\n" +
        c.script,
    );
    const calls = result.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content.filter((p) => p.type === "toolCall"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "subagent");
    assert.equal(calls[0].arguments.script, c.script);
    const results = result.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, c.error);
    const text = results[0].content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (c.error) {
      assert(text.includes("subagent_result_too_large"));
      assert(Buffer.byteLength(text) < 2048);
      const file = await api.readWorkspaceFile(session.sessionId, c.marker);
      assert.equal(Buffer.from(file.bytes).toString("utf8"), "once\n");
    } else {
      const value = JSON.parse(text);
      assert.equal(value.body, "x".repeat(48000));
      assert.equal(value.end, "COMPLETE_JSON");
    }
    report.cases.push({
      name: c.name,
      runId: result.runId,
      toolCalls: calls.length,
      isError: results[0].isError,
      resultBytes: Buffer.byteLength(text),
      ...(c.marker ? { effectOnce: true } : { completeJson: true }),
    });
  }
  console.log(JSON.stringify({ phase: "supervisor-reply" }));
  const result = await run(
    'Delegate exactly one fresh child with tools:[] using subagent action:run. Its task: Call contact_supervisor with reason need_decision and ask for an approved colour; wait for the reply and answer with that colour. When the child returns blocked, use subagent_supervisor action:reply with its replyTo request ID and message "APPROVED-TEAL". Do not launch another child or use workflow. Wait for the actual child response, then answer SUPERVISOR-TEAL-OK.',
  );
  const replies = result.messages.filter((m) => m.role === "toolResult");
  assert(
    replies.some(
      (m) =>
        m.toolName === "contact_supervisor" &&
        m.content.some((p) => p.type === "text" && p.text === "APPROVED-TEAL"),
    ),
  );
  assert(replies.some((m) => m.toolName === "subagent_supervisor" && !m.isError));
  assert(
    result.messages
      .filter((m) => m.role === "assistant")
      .some((m) =>
        m.content.some((p) => p.type === "text" && p.text.includes("SUPERVISOR-TEAL-OK")),
      ),
  );
  report.cases.push({ name: "supervisor-reply", runId: result.runId, childReplyPreserved: true });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 600);
} finally {
  const errors = [];
  const clean = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(String(error?.message ?? error).slice(0, 600));
    }
  };
  if (session)
    await clean(async () => {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      for (const row of rows) await settled(row.id);
      await api.deleteConversation(session.sessionId);
    });
  if (project)
    await clean(async () => {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("settlement-cleanup"));
      await until(
        async () =>
          Boolean(
            (
              await db
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", project.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          ),
        "Physical Workspace purge",
      );
    });
  if (tenant && errors.length === 0)
    await clean(async () => {
      blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
        ),
      });
      report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
    });
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) report.cleanupErrors = errors;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  blobs?.close();
  await db.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      cases: report.cases,
      failure: report.failure,
    }),
  );
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Native Tool settlement acceptance failed",
    );
}
