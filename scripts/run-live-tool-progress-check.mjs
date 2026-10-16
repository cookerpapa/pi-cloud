import { replacePod, serviceAddress } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { ToolPreviewBuffer, previewBytes } from "../packages/protocol/src/tool-preview.ts";
import { checkOwnedGuestReceipt } from "./lib/live-cube-receipt.mjs";

if (process.env.PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK !== "1")
  throw new Error("Opt in with PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK=1 (Luna tokens, Cube, browser)");
const port = (await readFile("deploy/production/runtime/.env", "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`,
  suffix = Date.now().toString(36);
const title = `Progress ${suffix}`;
const output = resolve(process.argv[2] ?? "dist/tool-progress-acceptance.json");
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const pg = new URL(
  (await readFile("deploy/production/runtime/secrets/database-url", "utf8")).trim(),
);
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
let tenant, failure, project, session, active, stream;
let snapshots = 0;
const abort = new AbortController();
const apiFetch = async (path, init = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      ...(tenant ? { authorization: `Bearer ${tenant.credential.token}` } : {}),
    },
  });
  return response;
};
const api = new PiCloudApi(apiFetch),
  exec = promisify(execFile);
const updates = [],
  events = [],
  report = {
    checkedAt: new Date().toISOString(),
    model: "gpt-6-luna",
    accepted: false,
    cleanupConfirmed: false,
    runs: [],
  };
const views = new Map();
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function waitRun(id, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = await api.getRun(id);
    if (terminal(run)) {
      const row = await db
        .selectFrom("runs")
        .select(["output_seal_id", "output_sealed_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (!row.output_seal_id || row.output_sealed_at) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Run did not settle");
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-progress-${suffix}`,
    ownerDisplayName: title,
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  project = await api.createProject(title);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    title,
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  // IDs retained privately for exact, owned metadata cleanup; not transcripts or credentials.
  report.resources = {
    tenantId: tenant.tenantId,
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: abort.signal,
    fetchImplementation: apiFetch,
    onSnapshot() {
      snapshots++;
      views.clear();
    },
    onStatus() {},
    onEvent(event) {
      events.push(event);
    },
    onToolProgress(progress) {
      let view = views.get(progress.operationId);
      if (!view) {
        view = new ToolPreviewBuffer();
        views.set(progress.operationId, view);
      }
      view.accept(progress.update);
      updates.push({
        ...progress,
        view: view.current,
        wireBytes: Buffer.byteLength(JSON.stringify(progress)),
        receivedAt: Date.now(),
      });
    },
  });
  void stream.catch(() => {});
  await withChromePage({ height: 600 }, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    await page.navigate(base);
    const select = async () => {
      await page.navigate(base);
      await page.waitFor(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(title)}))`,
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`,
      );
    };
    await select();
    const started = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      '只执行一次 bash 工具，timeout 设置为 180 秒，逐字使用以下命令，不要后台运行、不要重定向、不要子代理：python3 -u -c \'import time; print("x"*100000); [(print("OBS_TICK_"+str(i), flush=True), time.sleep(1)) for i in range(90)]; print("OBS_DONE")\'。完成后简短确认。',
      newIdempotencyKey("live-progress"),
      "low",
    );
    await page.waitFor("document.querySelector('.product-tool-progress button')", 60000);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress button').getAttribute('aria-expanded')",
      ),
      "false",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-tool-progress-tail')===null"),
      true,
    );
    await page.evaluate("document.querySelector('.product-tool-progress button').click()");
    await page.waitFor(
      "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
      20000,
    );
    const firstText = await page.evaluate(
      "document.querySelector('.product-tool-progress-tail').textContent",
    );
    assert(firstText.length <= 8192);
    await page.evaluate(
      "window.__progressScroll=document.querySelector('.product-tool-progress-tail').getBoundingClientRect().height",
    );
    await page.evaluate(
      "const area=document.querySelector('.product-chat-scroll');area.scrollTop=0;area.dispatchEvent(new Event('scroll'))",
    );
    await page.wait(2200);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress-tail').getBoundingClientRect().height===window.__progressScroll",
      ),
      true,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop"),
      0,
      "Progress scrolled the transcript",
    );
    await select();
    await page.waitFor("document.querySelector('.product-tool-progress button')", 15000);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress button').getAttribute('aria-expanded')",
      ),
      "false",
    );
    await page.evaluate("document.querySelector('.product-tool-progress button').click()");
    await page.waitFor(
      "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
      15000,
    );
    if (process.env.PI_CLOUD_TOOL_PROGRESS_RESTART_CHECK === "1") {
      const { stdout } = await exec(process.execPath, [
        "scripts/production-kubernetes.mjs",
        "exec",
        "postgres",
        "psql",
        "-U",
        "pi_cloud",
        "-d",
        "pi_cloud",
        "-Atc",
        "select id from runs where state in ('queued','running','cancelling') order by id",
      ]);
      assert.equal(stdout.trim(), active.runId, "Refuse process fault while other Runs are active");
      const before = snapshots;
      const restartStarted = Date.now();
      await replacePod("control-plane");
      report.replacementCommandMs = Date.now() - restartStarted;
      // Replace the Projector process, not the Worker or the running Tool.
      // Pod rollout can return before publication ownership/SSE recovers. The
      // isolated no-model crash probe measured 30 s, beyond the old 25 s check.
      const deadline = Date.now() + 60000;
      try {
        await page.waitFor(
          "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
          60000,
        );
      } catch (error) {
        const run = await api.getRun(active.runId);
        report.restartFailure = {
          elapsedMs: Date.now() - restartStarted,
          runState: run.state,
          failure: run.failure,
          snapshotsBefore: before,
          snapshotsAfter: snapshots,
          observations: updates
            .filter((u) => u.receivedAt >= restartStarted)
            .map((u) => ({
              elapsedMs: u.receivedAt - restartStarted,
              kind: u.update.kind,
              revision: u.update.revision,
              hasTick: u.view?.text.includes("OBS_TICK_"),
            })),
          browser: await page.evaluate(
            `(()=>{const button=document.querySelector('.product-tool-progress button');const tail=document.querySelector('.product-tool-progress-tail');return {button:!!button,expanded:button?.getAttribute('aria-expanded'),preview:!!tail,textLength:tail?.textContent.length,hasTick:tail?.textContent.includes('OBS_TICK_')}})()`,
          ),
        };
        throw error;
      }
      while (snapshots <= before && Date.now() < deadline) await page.wait(250);
      assert(snapshots > before, "No replacement snapshot after Projector restart");
      const updateCount = updates.length;
      while (updates.length <= updateCount && Date.now() < deadline) await page.wait(250);
      assert(updates.length > updateCount, "No new progress after Projector restart");
      report.projectorRestart = true;
      report.previewRecoveredMs = Date.now() - restartStarted;
    }
    const run = await waitRun(active.runId);
    assert.equal(run.state, "completed", JSON.stringify(run.failure));
    await page.waitFor("document.querySelector('.product-tool-progress')===null", 15000);
    const turn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const tools = turn.transcript.items.filter((i) => i.kind === "tool");
    assert.equal(tools.length, 1, "Process fault must not replay the command");
    assert.equal(tools[0].status, "completed");
    assert(JSON.stringify(tools[0].output).includes("OBS_DONE"));
    assert(Buffer.byteLength(JSON.stringify(tools[0].output)) < 65536);
    const sampled = updates.filter((u) => u.turnId === active.turnId);
    assert(sampled.length >= 3);
    assert(sampled.every((u) => previewBytes(u.update.text) <= 8192 && u.wireBytes < 65536));
    assert(
      sampled.some((u) => u.update.kind === "delta"),
      "No incremental preview reached SSE",
    );
    assert(
      sampled.some((u) => u.update.kind === "reset"),
      "No recovery snapshot reached SSE",
    );
    assert(
      sampled.every((u) => !u.view?.unavailable),
      "Ordinary output overloaded the preview parser",
    );
    report.runs.push({
      kind: "continuous-output",
      requestedCommandSeconds: 90,
      elapsedMs: Date.now() - started,
      progressCount: sampled.length,
      maximumPreviewBytes: Math.max(...sampled.map((u) => previewBytes(u.view?.text ?? ""))),
      maximumWireBytes: Math.max(...sampled.map((u) => u.wireBytes)),
      totalWireBytes: sampled.reduce((n, u) => n + u.wireBytes, 0),
      deltaCount: sampled.filter((u) => u.update.kind === "delta").length,
      resetCount: sampled.filter((u) => u.update.kind === "reset").length,
      modelTransportMs: (await readWorkerModelTimings([active.runId], started)).reduce(
        (sum, t) => sum + t.elapsedMs,
        0,
      ),
      commandExecutions: tools.length,
    });
    if (process.env.PI_CLOUD_LIVE_RECEIPT_CHECK === "1") {
      report.receiptFault = await checkOwnedGuestReceipt({
        tenantId: tenant.tenantId,
        workspaceId: project.workspaceId,
      });
    }
    active = await api.acceptTurn(
      session.sessionId,
      '只调用一次 bash，逐字执行下面命令，不要后台运行或重定向，不要其他工具：python3 -u -c \'import time; [(print("\\r\\x1b[2KOBS_PROGRESS_%03d%%" % i, end="", flush=True), time.sleep(1)) for i in range(15)]; print("\\r\\x1b[2KOBS_PROGRESS_DONE")\'。执行完成后简短确认。',
      newIdempotencyKey("terminal-preview"),
      "low",
    );
    await page.waitFor("document.querySelector('.product-tool-progress button')", 60000);
    await page.evaluate("document.querySelector('.product-tool-progress button').click()");
    await page.waitFor(
      "/OBS_PROGRESS_\\d{3}%/.test(document.querySelector('.product-tool-progress-tail')?.textContent ?? '')",
      20000,
    );
    const bar = await page.evaluate(
      "document.querySelector('.product-tool-progress-tail').textContent",
    );
    assert.equal(
      (bar.match(/OBS_PROGRESS_/g) ?? []).length,
      1,
      "Progress bar labels were concatenated",
    );
    assert(
      !bar.includes("\x1b") && !bar.includes("\r"),
      "Terminal controls leaked into preview text",
    );
    await page.waitFor(
      `(()=>{const text=document.querySelector('.product-tool-progress-tail')?.textContent;return text&&text!==${JSON.stringify(bar)}&&/OBS_PROGRESS_\\d{3}%/.test(text)})()`,
      8000,
    );
    assert.equal((await waitRun(active.runId)).state, "completed");
    const barTurn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const barTools = barTurn.transcript.items.filter((i) => i.kind === "tool");
    assert.equal(barTools.length, 1);
    assert(JSON.stringify(barTools[0].output).includes("OBS_PROGRESS_DONE"));
    report.runs.push({
      kind: "terminal-progress-bar",
      commandExecutions: 1,
      overwrittenInPlace: true,
    });
    const silentStart = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      "只执行一次 bash：sleep 25。不要增加 echo 或其他命令，完成后回复完成。",
      newIdempotencyKey("silent-progress"),
      "low",
    );
    assert.equal((await waitRun(active.runId)).state, "completed");
    assert.equal(updates.filter((u) => u.turnId === active.turnId).length, 0);
    report.runs.push({
      kind: "silent-command",
      elapsedMs: Date.now() - silentStart,
      progressCount: 0,
    });
    active = await api.acceptTurn(
      session.sessionId,
      "只执行一次 bash：echo CANCEL_STARTED; sleep 90; echo CANCEL_FINISHED。不要后台运行，不要其他工具。",
      newIdempotencyKey("cancel-progress"),
      "low",
    );
    const deadline = Date.now() + 60000;
    while (!updates.some((u) => u.turnId === active.turnId) && Date.now() < deadline)
      await page.wait(250);
    assert(updates.some((u) => u.turnId === active.turnId));
    await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cancel-observation"));
    assert.equal((await waitRun(active.runId)).state, "cancelled");
    await page.waitFor("document.querySelector('.product-tool-progress')===null", 15000);
    const count = updates.length;
    await page.wait(2500);
    assert.equal(updates.length, count, "Cancelled Tool leaked late progress");
    report.runs.push({ kind: "cancel", lateProgress: 0 });
    active = await api.acceptTurn(
      session.sessionId,
      "继续这个会话。依次实际使用四种工具：write 创建 insertion_sort.py，实现插入排序和空数组、重复值、负数、逆序的 assert 测试；read 读取它；edit 新增固定随机种子的随机测试；bash 执行 python3 insertion_sort.py。不要搜索或子代理，最后简要报告测试结果。",
      newIdempotencyKey("progress-coding"),
      "low",
    );
    assert.equal((await waitRun(active.runId)).state, "completed");
    const coding = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const calls = coding.transcript.items.filter((item) => item.kind === "tool");
    for (const name of ["write", "read", "edit", "bash"])
      assert(
        calls.some((call) => call.toolName === name && call.status === "completed"),
        `Missing completed ${name}`,
      );
    report.runs.push({
      kind: "coding-after-cancel",
      tools: calls.map((call) => ({ name: call.toolName, status: call.status })),
    });
  });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 600);
  if (active) {
    const run = await api.getRun(active.runId).catch(() => undefined);
    if (run) report.failedRun = { runId: active.runId, state: run.state, failure: run.failure };
  }
} finally {
  abort.abort();
  await stream?.catch(() => {});
  try {
    if (session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, waitRun);
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(
        project.workspaceId,
        newIdempotencyKey("cleanup-progress-workspace"),
      );
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const workspace = await db
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", project.workspaceId)
          .executeTakeFirst();
        const pending = await db
          .selectFrom("outbox")
          .select("id")
          .where("tenant_id", "=", tenant.tenantId)
          .where("published_at", "is", null)
          .execute();
        if (workspace?.storage_purged_at && !pending.length) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (tenant) {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            "deploy/production/runtime/secrets/session-image-s3-credentials.json",
            "utf8",
          ),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error?.message ?? error).slice(0, 600);
    failure ??= error;
  }
  await db.destroy();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
