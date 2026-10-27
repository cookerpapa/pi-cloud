// One owned Luna/Cube Run against the deployed Web; no user conversation mutations.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_HISTORY_LAYOUT_CHECK,
  "1",
  "Authorize the owned Luna/Cube fixture",
);
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/live-history-layout",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = {
  at: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
};
let tenant, api, project, session, run, failure;
const terminal = (r) => ["completed", "cancelled", "failed", "timed_out"].includes(r.state);
async function until(read, label, budget = 600000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw Error(label + " timed out");
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-layout-${randomUUID()}`,
    ownerDisplayName: "History layout acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("History layout acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "流式布局验收",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  await withChromePage({ width: 1280, height: 900 }, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      window.layoutSamples=[];window.layoutErrors=[];addEventListener('error',e=>layoutErrors.push(e.message));
      window.geometry=()=>{const p=document.querySelector('.product-chat-scroll');if(!p)return null;const b=p.getBoundingClientRect(),rows=[...p.querySelectorAll('[data-history-row-key]')].map(e=>({i:Number(e.dataset.index),r:e.getBoundingClientRect()}));let gap=0,overlap=0;for(let i=1;i<rows.length;i++){const a=rows[i-1],n=rows[i];if(n.i===a.i+1&&n.r.top>b.top&&a.r.bottom<b.bottom){gap=Math.max(gap,n.r.top-a.r.bottom);overlap=Math.max(overlap,a.r.bottom-n.r.top);}}return {t:performance.now(),gap,overlap,end:p.scrollHeight-p.scrollTop-p.clientHeight,rows:rows.length,text:p.querySelectorAll('.product-process-narration,.product-assistant-text').length};};
      function sample(){requestAnimationFrame(()=>setTimeout(()=>{const g=geometry();if(g&&g.rows){layoutSamples.push(g);if(layoutSamples.length>20000)layoutSamples.shift();}sample();},0));}sample();`,
    });
    await page.navigate(origin + "/?session=" + session.sessionId);
    await page.waitFor("document.querySelector('.product-composer textarea')");
    run = await api.acceptTurn(
      session.sessionId,
      "这是流式布局验收。请依次做三步：每步先输出一句不同的简短中文进展，然后调用 bash 执行对应命令 `printf 'LAYOUT_STEP_1\\n'`、`printf 'LAYOUT_STEP_2\\n'`、`printf 'LAYOUT_STEP_3\\n'`。只调用这三次 bash，不使用其他工具。最后以自然段写约 400 字说明三步都完成了，并以 LAYOUT_STREAM_OK 结尾，不要代码围栏。",
      newIdempotencyKey("layout-live"),
    );
    assert.equal(run.kind, "run");
    report.runId = run.runId;
    const done = await until(async () => {
      const r = await api.getRun(run.runId);
      return terminal(r) ? r : false;
    }, "Streaming Run");
    assert.equal(done.state, "completed", JSON.stringify(done.failure));
    await page.waitFor(
      "document.querySelector('.product-chat-scroll').textContent.includes('LAYOUT_STREAM_OK')",
      60000,
    );
    await page.wait(500);
    const observation = await page.evaluate(
      "({samples:layoutSamples,last:geometry(),errors:layoutErrors,browsing:Boolean(document.querySelector('.product-return-to-latest'))})",
    );
    assert.deepEqual(observation.errors, []);
    assert(!observation.browsing, "Output accidentally entered history browsing mode");
    assert(
      observation.last.gap < 4 && observation.last.overlap < 4,
      "Layout did not settle without a scroll",
    );
    assert(observation.last.end < 80, "The stream lost its latest edge");
    let since = null,
      longestMismatchMs = 0;
    for (const frame of observation.samples) {
      if (frame.gap > 4 || frame.overlap > 4) since ??= frame.t;
      else if (since !== null) {
        longestMismatchMs = Math.max(longestMismatchMs, frame.t - since);
        since = null;
      }
    }
    if (since !== null)
      longestMismatchMs = Math.max(longestMismatchMs, observation.samples.at(-1).t - since);
    assert(longestMismatchMs < 80, "A layout mismatch persisted across multiple frames");
    const messages = nativeMessages(
      await nativeHistory(db, { tenantId: tenant.tenantId, runId: run.runId }),
    );
    const tools = messages.filter((m) => m.role === "toolResult");
    assert.equal(tools.length, 3);
    assert(tools.every((m) => m.toolName === "bash" && !m.isError));
    const assistantText = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "text");
    assert(assistantText.length >= 2, "Need both intermediate and final text");
    report.geometry = {
      samples: observation.samples.length,
      longestMismatchMs,
      last: observation.last,
      toolResults: tools.length,
      textMessages: assistantText.length,
    };
    await writeFile(resolve(directory, "frames.json"), JSON.stringify(observation), {
      mode: 0o600,
    });
    await page.screenshot(resolve(directory, "stream.png"));
  });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 1200);
} finally {
  try {
    if (run && !terminal(await api.getRun(run.runId))) {
      await api.cancelTurn(session.sessionId, run.turnId, newIdempotencyKey("layout-stop"));
      await until(async () => terminal(await api.getRun(run.runId)), "Stop owned Run");
    }
    if (session) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("session_leases")
              .select("lease_id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("released_at", "is", null)
              .execute()
          ).length,
        "Writer closure",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("layout-cleanup"));
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Physical Workspace purge",
      );
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
        "Control cleanup",
      );
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"),
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
    failure ??= error;
    report.cleanupFailure = String(error?.message ?? error).slice(0, 700);
  }
  await db.destroy();
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
