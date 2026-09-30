import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_WORKSPACE_REBIND_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_WORKSPACE_REBIND_CHECK=1 for an owned test machine, Luna and browser acceptance",
  );
const runtime = "deploy/production/runtime";
const env = await readFile(`${runtime}/.env`, "utf8");
const port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`;
const pg = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pg.hostname = JSON.parse(
  execFileSync("docker", ["inspect", "pi-cloud-production-postgres-1"], { encoding: "utf8" }),
)[0].NetworkSettings.Networks["pi-cloud-production_database"].IPAddress;
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
let tenant, api, project, session, machine, active, failure;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (s) => ["completed", "failed", "cancelled", "timed_out"].includes(s);
async function until(fn, label, timeout = 240_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(400);
  }
  throw new Error(`${label} timed out`);
}
async function turn(prompt) {
  active = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("rebind-check"),
    "low",
  );
  const result = await until(async () => {
    const r = await api.getRun(active.runId);
    return terminal(r.state) && r;
  }, "Run");
  assert.equal(result.state, "completed", JSON.stringify(result.failure));
  const t = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === active.runId,
  );
  report.runs.push({
    runId: active.runId,
    workspaceId: result.workspaceId,
    workerId: result.workerId,
    tools: t.transcript.items
      .filter((i) => i.kind === "tool")
      .map((i) => ({ name: i.toolName, status: i.status })),
  });
  return t;
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `rebind-check-${Date.now().toString(36)}`,
    ownerDisplayName: "Workspace rebind acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Rebind original", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Workspace recovery acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  const marker = `MEMORY_${randomUUID().slice(0, 8)}`;
  await turn(`请记住验收标记 ${marker}。本轮不要工具，只回复已记住。稍后我会切换工作目录。`);
  const originalModel = await api.getSessionModel(session.sessionId);
  const { rows: originalHistory } =
    await sql`select seq,payload from pi_session_log where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} order by seq`.execute(
      db,
    );
  const historyDigest = createHash("sha256").update(JSON.stringify(originalHistory)).digest("hex");
  await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("rebind-delete"));
  assert.equal((await api.getConversation(session.sessionId)).session.workspaceState, "missing");
  machine = await api.createDevelopmentEnvironment(
    "Rebind target machine",
    "starter",
    newIdempotencyKey("environment"),
  );
  await until(async () => {
    const list = await api.listDevelopmentEnvironments();
    const m = list.environments.find((e) => e.environmentId === machine.environmentId);
    return m?.state === "running";
  }, "Machine ready");
  await api.createDevelopmentEnvironmentDirectory(
    machine.environmentId,
    "/home/user",
    "rebind-proof",
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    originalWorkspaceId: project.workspaceId,
    environmentId: machine.environmentId,
    machineWorkspaceId: machine.workspaceId,
  };
  await withChromePage({}, async (page) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "localStorage.setItem('pi-cloud:ui-language','zh-CN')",
    });
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
    });
    await page.navigate(`${base}/?session=${session.sessionId}`);
    await page.waitFor(
      "document.querySelector('.product-rebind-modal select') && !document.querySelector('.product-rebind-modal fieldset').disabled",
      30_000,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-rebind-modal select').value"),
      machine.environmentId,
    );
    await page.evaluate(
      "Array.from(document.querySelectorAll('.product-rebind-modal button')).find(b=>b.textContent.includes('选择目录')).click()",
    );
    await page.waitFor(
      "Array.from(document.querySelectorAll('.product-directory-entry-directory')).some(b=>b.textContent.includes('rebind-proof'))",
      30_000,
    );
    await page.evaluate(
      "Array.from(document.querySelectorAll('.product-directory-entry-directory')).find(b=>b.textContent.includes('rebind-proof')).click()",
    );
    await page.waitFor(
      "document.querySelector('.product-directory-selection code')?.textContent==='/home/user/rebind-proof'",
    );
    await page.evaluate(
      "document.querySelector('.product-directory-picker footer .product-primary-button').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-rebind-modal code')?.textContent==='/home/user/rebind-proof'",
    );
    await page.evaluate(
      "document.querySelector('.product-rebind-modal button[type=submit]').click()",
    );
    await page.waitFor(
      "!document.querySelector('.product-rebind-modal') && !document.querySelector('.product-workspace-missing-banner')",
      30_000,
    );
    report.browserMachineSelection = true;
  });
  const rebound = (await api.getConversation(session.sessionId)).session;
  assert.equal(rebound.executionMode, "development_environment");
  assert.equal(rebound.developmentEnvironmentId, machine.environmentId);
  assert.equal(rebound.workingDirectory, "/home/user/rebind-proof");
  const selected = await api.getSessionModel(session.sessionId);
  for (const key of ["provider", "modelId", "thinkingLevel", "fastMode"])
    assert.deepEqual(selected[key], originalModel[key]);
  const { rows: preserved } =
    await sql`select seq,payload from pi_session_log where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} and seq <= ${originalHistory.at(-1).seq} order by seq`.execute(
      db,
    );
  assert.equal(createHash("sha256").update(JSON.stringify(preserved)).digest("hex"), historyDigest);
  const result = await turn(
    "请实际用 bash 执行 pwd，然后 write 创建 proof.txt，内容为 REBOUND_OK。最后说出前一轮要求记住的验收标记，并报告当前目录。不要创建其他目录、不要搜索或子代理。",
  );
  const text = result.transcript.items
    .filter((i) => i.kind === "text")
    .map((i) => i.text)
    .join("\n");
  assert(text.includes(marker), "Conversation memory was lost");
  const tools = result.transcript.items.filter((i) => i.kind === "tool");
  assert(
    tools.some(
      (i) =>
        i.toolName === "bash" &&
        i.status === "completed" &&
        JSON.stringify(i.output).includes("/home/user/rebind-proof"),
    ),
  );
  assert(tools.some((i) => i.toolName === "write" && i.status === "completed"));
  assert.equal(
    Buffer.from((await api.readWorkspaceFile(session.sessionId, "proof.txt")).bytes)
      .toString()
      .trim(),
    "REBOUND_OK",
  );
  report.historyPreserved = true;
  report.modelSettingsPreserved = true;
  report.nextRunUsesMachineDirectory = true;
  const { rows: facts } =
    await sql`select payload from pi_session_log where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} and custom_type='pi-cloud.workspace_changed'`.execute(
      db,
    );
  assert.equal(facts.length, 1);
  assert(!JSON.stringify(facts).includes("The current /workspace"));
  report.workspaceChangedFact = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  const clean = async (fn) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };
  if (active)
    await clean(async () => {
      if (!terminal((await api.getRun(active.runId)).state)) {
        await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cleanup"));
        await until(async () => terminal((await api.getRun(active.runId)).state), "Cleanup Run");
      }
    });
  if (session) await clean(() => api.deleteConversation(session.sessionId));
  if (machine)
    await clean(() =>
      api.developmentEnvironmentAction(
        machine.environmentId,
        "release",
        newIdempotencyKey("cleanup"),
      ),
    );
  if (project)
    await clean(() => api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup")));
  if (tenant)
    await clean(() =>
      db
        .updateTable("tenant_api_credentials")
        .set({ revoked_at: new Date() })
        .where("credential_id", "=", tenant.credential.credentialId)
        .execute(),
    );
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-workspace-rebind-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Workspace rebind acceptance failed",
    );
}
console.log(JSON.stringify(report));
