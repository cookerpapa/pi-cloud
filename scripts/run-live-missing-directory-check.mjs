import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { nativeHistory, nativeMessages, runUsage } from "./lib/native-session-history.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";

if (process.env.PI_CLOUD_LIVE_MISSING_DIRECTORY_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_MISSING_DIRECTORY_CHECK=1 for a disposable Cube and GPT-6 Luna acceptance",
  );
const output = resolve(process.argv[2] ?? "dist/missing-directory-acceptance.json");
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const baseUrl = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  runs: [],
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
let tenant, api, machine, session, failure;
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, budget = 300000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(label + " timed out");
}
async function settled(runId) {
  const run = await until(async () => {
    const r = await api.getRun(runId);
    return terminal(r) && r;
  }, "Run settlement");
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "Run seal");
  return run;
}
async function turn(prompt) {
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("cwd-check"),
    "low",
  );
  const run = await settled(accepted.runId);
  const history = await nativeHistory(db, { runId: run.runId });
  report.runs.push({
    runId: run.runId,
    state: run.state,
    usage: runUsage(history),
    ...(run.failure ? { failure: run.failure } : {}),
  });
  assert.equal(run.state, "completed", run.failure?.code ?? "Run failed");
  return nativeMessages(history);
}
const machineRow = () =>
  db
    .selectFrom("development_environments")
    .select(["runtime_id", "state"])
    .where("id", "=", machine.environmentId)
    .where("tenant_id", "=", tenant.tenantId)
    .executeTakeFirstOrThrow();
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-cwd-" + Date.now().toString(36),
    ownerDisplayName: "Directory failure acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), baseUrl), init),
    tenant.credential.token,
  );
  machine = await api.createDevelopmentEnvironment(
    "Directory failure acceptance",
    "starter",
    newIdempotencyKey("cwd-machine"),
  );
  report.environmentId = machine.environmentId;
  report.workspaceId = machine.workspaceId;
  await until(async () => {
    const current = await machineRow();
    if (current.state === "failed") throw new Error("Fixture machine failed to start");
    return current.state === "running";
  }, "Fixture machine");
  const original = await machineRow();
  const name = "cwd-acceptance",
    cwd = "/home/user/" + name,
    marker = "/home/user/cwd-must-not-execute";
  await api.createDevelopmentEnvironmentDirectory(machine.environmentId, "/home/user", name);
  session = await api.createSession(
    machine.projectId,
    machine.workspaceId,
    "Deleted directory conversation",
    "development_environment",
    "starter",
    cwd,
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  console.log(
    JSON.stringify({ phase: "delete-directory-and-continue", at: new Date().toISOString() }),
  );
  const messages = await turn(
    `这是一次已授权的临时目录故障验收。严格按顺序执行两次独立 bash 调用：第一次 command 必须是 rmdir ${cwd} && printf CWD_REMOVED；收到结果后，第二次 command 必须是 printf SHOULD_NOT_RUN > ${marker}。第二次预期因工作目录消失而失败。无论第二次是否成功，都不要继续调用工具，不要修复、重建目录、修改 cwd、搜索或委派。最后用自然语言说明第二次的实际工具结果，并包含标记 CWD_ERROR_HANDLED。这里只能删除上面明确指定的临时空目录。`,
  );
  const tools = messages.filter((m) => m.role === "toolResult");
  assert.equal(tools.length, 2, "Expected exactly two Tool calls");
  assert.equal(tools[0].isError, false);
  assert.match(JSON.stringify(tools[0].content), /CWD_REMOVED/);
  assert.equal(tools[1].isError, true);
  assert.match(JSON.stringify(tools[1].content), /tool_root_unavailable/);
  assert(
    messages
      .slice(messages.indexOf(tools[1]) + 1)
      .some(
        (m) => m.role === "assistant" && JSON.stringify(m.content).includes("CWD_ERROR_HANDLED"),
      ),
    "No native assistant continuation after the Tool error",
  );
  const listing = await api.listDevelopmentEnvironmentDirectory(
    machine.environmentId,
    "/home/user",
  );
  assert(
    !listing.entries.some((e) => [name, "cwd-must-not-execute"].includes(e.name)),
    "Directory was repaired or the refused command executed",
  );
  assert.deepEqual(await machineRow(), original, "Directory failure changed the VM identity/state");
  report.sameRunContinuation = true;
  report.noCommandEffectOrDirectoryRecreation = true;
  report.sameVmAfterError = true;
  const chat = await turn("本轮不要调用任何工具，只回复 CHAT_AFTER_CWD_DELETE_OK。");
  assert(!chat.some((m) => m.role === "toolResult"));
  assert(
    chat.some(
      (m) =>
        m.role === "assistant" && JSON.stringify(m.content).includes("CHAT_AFTER_CWD_DELETE_OK"),
    ),
  );
  report.chatAfterDeletion = true;
  await api.createDevelopmentEnvironmentDirectory(machine.environmentId, "/home/user", name);
  const restored = await turn(
    "工作目录已由用户恢复。只调用一次 bash 执行 pwd && printf RESTORED_CWD_OK，然后简短报告；不要搜索或委派。",
  );
  assert(
    restored.some(
      (m) =>
        m.role === "toolResult" &&
        !m.isError &&
        JSON.stringify(m.content).includes("RESTORED_CWD_OK") &&
        JSON.stringify(m.content).includes(cwd),
    ),
  );
  assert.deepEqual(await machineRow(), original);
  report.explicitRestorationWorks = true;
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 600);
} finally {
  const errors = [];
  try {
    if (session) {
      const runs = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, runs, settled);
      for (const run of runs) await settled(run.id);
      await api.deleteConversation(session.sessionId);
    }
    if (machine) {
      await api.developmentEnvironmentAction(
        machine.environmentId,
        "release",
        newIdempotencyKey("cwd-release"),
      );
      await until(async () => {
        const workspace = await db
          .selectFrom("workspaces")
          .select(["deleted_at", "storage_purged_at"])
          .where("id", "=", machine.workspaceId)
          .executeTakeFirstOrThrow();
        return workspace.deleted_at && workspace.storage_purged_at;
      }, "Owned machine Volume purge");
      // Physical cleanup precedes removing only this fixture's ownership rows.
      await db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom("development_environments")
          .select(["state", "runtime_id"])
          .where("tenant_id", "=", tenant.tenantId)
          .where("id", "=", machine.environmentId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        assert.equal(row.state, "released");
        assert.equal(row.runtime_id, null);
        await tx
          .deleteFrom("sandbox_http_services")
          .where("tenant_id", "=", tenant.tenantId)
          .execute();
        await tx
          .deleteFrom("development_environment_operations")
          .where("tenant_id", "=", tenant.tenantId)
          .where("environment_id", "=", machine.environmentId)
          .execute();
        await tx
          .deleteFrom("development_environments")
          .where("tenant_id", "=", tenant.tenantId)
          .where("id", "=", machine.environmentId)
          .execute();
      });
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .execute()
          ).length,
        "Owned controls",
      );
      report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, {
        delete: async () => {
          throw new Error("Unexpected image in directory-only fixture");
        },
      });
    }
  } catch (error) {
    errors.push(String(error?.message ?? error).slice(0, 400));
  }
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) report.cleanupErrors = errors;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await db.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      runs: report.runs,
    }),
  );
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Directory failure acceptance failed",
    );
}
