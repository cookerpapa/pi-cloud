import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID, randomInt, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  nativeHistory,
  nativeMessages,
  runUsage,
  imageReferences,
} from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
} from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_DEEPSEEK_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_DEEPSEEK_CHECK=1 to authorize owned Flash/Cube fixtures; search is not tested",
  );
const output = resolve(
  process.env.PI_CLOUD_ACCEPTANCE_REPORT ?? "dist/deepseek-flash-acceptance.json",
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const blobs = new S3ImageBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(
    await readFile(resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"), "utf8"),
  ),
});
const baseUrl = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const selection = {
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  thinkingLevel: "off",
  fastMode: false,
};
const report = {
  checkedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: selection,
  deployedImage: JSON.parse(kubectl(["get", "deployment/pi-cloud-control-plane", "-o", "json"]))
    .spec.template.spec.containers[0].image,
  accepted: false,
  searchTested: false,
  checks: [],
  cleanupConfirmed: false,
};
let tenant, api, project, session, failure;
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(read, label, budget = 240_000) {
  const deadline = Date.now() + budget;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function settled(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : undefined;
  }, "Flash Run settlement");
  await until(async () => {
    const row = await database
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "native seal");
  return run;
}
function assistantText(messages) {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
async function turn(name, prompt, thinkingLevel, uploads = []) {
  const started = performance.now();
  const accepted = await api.acceptTurn(
    session.sessionId,
    `${prompt}\n不要搜索、访问互联网或委派子代理。`,
    newIdempotencyKey("turn"),
    thinkingLevel,
    uploads.map((u) => u.id),
  );
  const run = await settled(accepted.runId),
    history = await nativeHistory(database, { runId: accepted.runId }),
    messages = nativeMessages(history);
  const tools = messages.filter((m) => m.role === "toolResult");
  const snapshot = await database
    .selectFrom("runs")
    .select(["provider", "model_id", "thinking_level"])
    .where("turn_id", "=", accepted.turnId)
    .executeTakeFirstOrThrow();
  const hosted = messages
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "text" && p.providerHostedTool?.toolName === "web_search");
  const entry = {
    name,
    runId: run.runId,
    state: run.state,
    durationMs: Math.round(performance.now() - started),
    snapshot,
    tools: tools.map((t) => ({ name: t.toolName, isError: t.isError })),
    hostedCalls: hosted.length,
    imageReferences: imageReferences(history).length,
    usage: runUsage(history),
  };
  report.checks.push(entry);
  if (run.state !== "completed")
    entry.failure = {
      result: run.failure,
      modelErrors: messages
        .filter((m) => m.role === "assistant" && m.stopReason === "error")
        .map((m) => String(m.errorMessage ?? "Model request failed").slice(0, 1000)),
    };
  await save();
  assert.equal(run.state, "completed", `Flash ${name} failed: ${run.failure?.code ?? run.state}`);
  assert.deepEqual(snapshot, {
    provider: selection.provider,
    model_id: selection.modelId,
    thinking_level: thinkingLevel,
  });
  assert.equal(hosted.length, 0, "The fixture unexpectedly invoked a hosted tool");
  assert(
    tools.every((t) => !t.isError),
    "A fixed Tool failed",
  );
  assert(
    messages
      .filter((m) => m.role === "assistant")
      .every((m) => m.provider === selection.provider && m.model === selection.modelId),
    "Unexpected model in native history",
  );
  console.log(
    JSON.stringify({
      check: name,
      state: run.state,
      milliseconds: entry.durationMs,
      tools: entry.tools.map((t) => t.name),
    }),
  );
  return { text: assistantText(messages), tools, entry };
}
try {
  tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-flash-${Date.now().toString(36)}`,
    ownerDisplayName: "Flash acceptance",
    initialModel: selection,
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), baseUrl), init),
    tenant.credential.token,
  );
  const catalog = await api.getModelCatalog();
  report.catalogVisible = JSON.stringify(catalog).includes(selection.modelId);
  assert(report.catalogVisible, "Flash is missing from the selectable catalog");
  project = await api.createProject("Flash acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Flash without search",
    "elastic",
    "starter",
    "/workspace",
    selection,
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  await save();
  const marker = `FLASH_${randomUUID().slice(0, 8)}`;
  const chat = await turn(
    "text",
    `记住这个会话标记：${marker}。不要调用任何工具。仅回复这个标记。`,
    "off",
  );
  assert.equal(chat.tools.length, 0);
  assert.equal(chat.text.trim(), marker);
  const code = `def total(values):\n    return sum(values)\n\nassert total([9, 13, 20]) == 42\nprint(${JSON.stringify(marker)})\n`;
  const coding = await turn(
    "write-and-bash",
    `使用 write 将以下代码原样保存到 /workspace/flash_check.py，然后使用 bash 执行 python3 /workspace/flash_check.py。两个工具都必须实际调用，成功后只回复执行输出。\n${code}`,
    "off",
  );
  assert(coding.tools.some((t) => t.toolName === "write"));
  assert(coding.tools.some((t) => t.toolName === "bash"));
  assert(coding.text.includes(marker));
  const stored = await api.readWorkspaceFile(session.sessionId, "flash_check.py");
  assert.equal(Buffer.from(stored.bytes).toString("utf8").trim(), code.trim());
  await api.updateSessionModel(session.sessionId, { ...selection, thinkingLevel: "high" });
  const followup = await turn(
    "high-thinking-follow-up",
    "继续修改上一轮文件：将 total 改为只累加偶数。把验证改为 total([9,13,20,22]) == 42，并增加 total([1,2,3,4]) == 6 和 total([1,3,5]) == 0 两条断言。保留原有 print 标记。用工具保存修改并用 bash 实际执行，最后仅回复第一轮记住的标记。",
    "high",
  );
  assert(followup.tools.some((t) => ["write", "edit"].includes(t.toolName)));
  assert(followup.tools.some((t) => t.toolName === "bash"));
  assert(followup.text.includes(marker));
  await api.updateSessionModel(session.sessionId, selection);
  const digits = String(randomInt(100000, 999999));
  const png = await sharp(
    Buffer.from(
      `<svg width="600" height="240"><rect width="600" height="240" fill="white"/><text x="300" y="150" text-anchor="middle" font-family="sans-serif" font-size="85">${digits}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const upload = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob([png], { type: "image/png" }),
    "flash-vision.png",
  );
  const vision = await turn(
    "attached-image",
    "直接看这张附图，不要调用工具，只回复图中的六位数字。",
    "off",
    [upload],
  );
  assert.equal(vision.tools.length, 0);
  assert.equal(vision.text.trim(), digits);
  assert(vision.entry.imageReferences > 0);
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 1000);
} finally {
  const errors = [];
  try {
    if (session) {
      const rows = await database
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await until(
        async () =>
          !(
            await database
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .where("output_seal_id", "is not", null)
              .where("output_sealed_at", "is", null)
              .execute()
          ).length,
        "fixture seals",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
      await until(
        async () =>
          Boolean(
            (
              await database
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", project.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          ),
        "physical Workspace purge",
      );
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await database
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .execute()
          ).length,
        "fixture controls",
      );
      report.cleanup = await purgeOwnedAcceptanceTenant(database, tenant, blobs);
    }
  } catch (error) {
    errors.push(String(error?.message ?? error).slice(0, 500));
  }
  if (tenant && errors.length)
    await database
      .updateTable("tenant_api_credentials")
      .set({ revoked_at: new Date() })
      .where("tenant_id", "=", tenant.tenantId)
      .execute();
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) report.cleanupErrors = errors;
  await save();
  blobs.close();
  await database.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      checks: report.checks.map((c) => ({ name: c.name, state: c.state })),
      cleanupConfirmed: report.cleanupConfirmed,
      searchTested: false,
      failure: report.failure,
    }),
  );
  if (failure || errors.length)
    throw new Error("Flash acceptance failed; inspect its bounded private report");
}
