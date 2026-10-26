import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  podFor,
  kubectl,
  signalService,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_SCHEDULES_CHECK,
  "1",
  "Authorize owned Luna/Cube scheduling fixtures",
);
const directory = resolve(process.argv[2] ?? "deploy/production/runtime/diagnostics/schedules");
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = {
  at: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  checks: {},
};
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 3 });
const baseUrl = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, budget = 600000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw Error(label + " timed out");
}
let tenant, api, project, failure;
const sessions = [];
const rows = (id) =>
  db
    .selectFrom("runs")
    .select(["id", "turn_id", "state", "scheduled_origin", "input_text"])
    .where("session_id", "=", id)
    .orderBy("mailbox_position")
    .execute();
const settled = (id) =>
  until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : false;
  }, "Run settlement");
async function completed(id) {
  const run = await settled(id);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  return run;
}
async function messages(id) {
  return nativeMessages(await nativeHistory(db, { tenantId: tenant.tenantId, runId: id }));
}
function text(messages) {
  return messages
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : (m.content?.filter((p) => p.type === "text").map((p) => p.text) ?? []),
    )
    .join("\n");
}
async function createSession(title) {
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    title,
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  sessions.push(session);
  await save();
  return session;
}
async function plan(session, name) {
  return until(
    async () => (await api.listSchedules(session.sessionId)).schedules.find((p) => p.name === name),
    "Plan " + name,
  );
}
async function scheduledRun(session, id) {
  return until(
    async () => (await rows(session.sessionId)).find((r) => r.scheduled_origin?.scheduleId === id),
    "Scheduled Run",
  );
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-schedules-${randomUUID()}`,
    ownerDisplayName: "Schedule acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  await save();
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), baseUrl), init),
    tenant.credential.token,
  );
  project = await api.createProject("Schedule acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  const plain = await createSession("定时任务验收");
  report.plainSessionId = plain.sessionId;
  await save();
  phase("real tool creation and one-off Run without Sandbox");
  const root = await api.acceptTurn(
    plain.sessionId,
    '这是系统验收。请使用 schedule 工具创建两个计划，然后回复 PLANS_CREATED，不要使用其他工具。第一个 name 必须是 "一次性验收"，prompt 必须是 "不要调用任何工具，只回复 SCHEDULE_ONCE_OK。"，timing 是 {"kind":"after","seconds":3}。第二个 name 必须是 "管理验收"，prompt 是 "不要调用工具，只回复 MANAGEMENT_OK。"，timing 是 {"kind":"cron","expression":"0 8 * * *","timezone":"Asia/Shanghai"}。不要等待定时任务，创建完成后就结束本轮。',
    newIdempotencyKey("schedule-create"),
  );
  assert.equal(root.kind, "run");
  const once = await plan(plain, "一次性验收"),
    managed = await plan(plain, "管理验收");
  await completed(root.runId);
  const first = await scheduledRun(plain, once.id);
  await completed(first.id);
  assert.equal(first.input_text, "不要调用任何工具，只回复 SCHEDULE_ONCE_OK。");
  assert(
    text((await messages(first.id)).filter((m) => m.role === "assistant")).includes(
      "SCHEDULE_ONCE_OK",
    ),
  );
  assert(
    (await messages(root.runId)).some(
      (m) => m.role === "toolResult" && m.toolName === "schedule" && !m.isError,
    ),
  );
  assert.equal(
    (
      await db
        .selectFrom("workspace_runtimes")
        .select("workspace_runtime_id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute()
    ).length,
    0,
  );
  report.checks.oneOff = {
    rootRunId: root.runId,
    scheduledRunId: first.id,
    sameSession: true,
    canonicalPromptUnchanged: true,
    noSandbox: true,
  };
  await save();

  phase("deployed browser source badge and direct schedule management");
  await withChromePage(
    { profilePrefix: "pi-cloud-schedules-live-", width: 1280, height: 900 },
    async (page) => {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `localStorage.setItem('pi-cloud:ui-language','zh-CN');const originalFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{const url=new URL(input instanceof Request?input.url:String(input),location.href);const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));if(url.origin===location.origin&&url.pathname.startsWith('/v1/'))headers.set('authorization',${JSON.stringify("Bearer " + tenant.credential.token)});return originalFetch(input,{...init,headers});};`,
      });
      await page.navigate(`${baseUrl}/?session=${plain.sessionId}`);
      await page.waitFor(`document.querySelector('[data-scheduled-origin="${once.id}"]')`);
      assert.equal(
        await page.evaluate(
          `document.querySelectorAll('[data-scheduled-origin="${once.id}"]').length`,
        ),
        1,
      );
      const click = async (label, scope = "document") => {
        await page.waitFor(
          `[...${scope}.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`,
        );
        await page.evaluate(
          `[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`,
        );
      };
      await click("定时任务");
      const card = `document.querySelector('[data-schedule-id="${managed.id}"]')`;
      await page.waitFor(card);
      await click("编辑", card);
      await page.waitFor("document.querySelector('.product-schedule-editor input')");
      await page.evaluate(
        `(()=>{const input=document.querySelector('.product-schedule-editor input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'网页编辑验收');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await click("保存");
      await page.waitFor(
        "!document.querySelector('.product-schedule-editor')&&document.body.innerText.includes('网页编辑验收')",
      );
      await click("暂停", card);
      await page.waitFor(`${card}?.innerText.includes('已暂停')`);
      await click("恢复", card);
      await page.waitFor(`${card}?.innerText.includes('待触发')`);
      const changed = await api.getSchedule(plain.sessionId, managed.id);
      assert.deepEqual(changed.timing, managed.timing);
      assert.equal(changed.name, "网页编辑验收");
      await page.screenshot(resolve(directory, "browser-schedules.png"));
      report.checks.browser = {
        liveSourceBadge: true,
        editPauseResume: true,
        unchangedCalendar: true,
      };
    },
  );
  await save();

  if (process.env.PI_CLOUD_SCHEDULES_RESTART_CHECK === "1") {
    phase("owned deadline across Control Plane crash");
    await until(
      async () =>
        !(
          await sql`select 1 from runs where state not in ('completed','cancelled','failed','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null) limit 1`.execute(
            db,
          )
        ).rows.length,
      "No active work before owned Control Plane crash",
      120000,
    );
    let p = await api.getSchedule(plain.sessionId, managed.id);
    p = await api.changeSchedule(plain.sessionId, p.id, {
      action: "update",
      revision: p.revision,
      patch: {
        timing: { kind: "after", seconds: 5 },
        prompt: "不要调用任何工具，只回复 SCHEDULE_RESTART_OK。",
      },
    });
    const pod = podFor("control-plane");
    const state = () =>
      JSON.parse(kubectl(["get", "pod", pod, "-o", "json"])).status.containerStatuses[0];
    const before = state();
    let paused;
    try {
      paused = signalService("control-plane", "SIGSTOP");
      assert(Date.now() < Date.parse(p.nextFireAt), "Pause must precede the owned deadline");
      await delay(6500);
      signalService("control-plane", "SIGKILL", paused);
      paused = undefined;
    } finally {
      if (paused) {
        try {
          signalService("control-plane", "SIGCONT", paused);
        } catch {}
      }
    }
    await until(
      async () => state().restartCount > before.restartCount,
      "Control Plane container restart",
      120000,
    );
    await until(
      async () => {
        try {
          return (
            await fetch(`http://${serviceAddress("control-plane")}:3000/health/ready`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "Control Plane readiness",
      120000,
    );
    const recovered = await scheduledRun(plain, p.id);
    await completed(recovered.id);
    assert.equal(
      (await rows(plain.sessionId)).filter((r) => r.scheduled_origin?.scheduleId === p.id).length,
      1,
    );
    assert(
      text((await messages(recovered.id)).filter((m) => m.role === "assistant")).includes(
        "SCHEDULE_RESTART_OK",
      ),
    );
    report.checks.restart = {
      plannedAt: p.nextFireAt,
      runId: recovered.id,
      exactlyOneAdmission: true,
      containerRestarted: true,
    };
    await save();
  }

  phase("busy Session keeps steer in the active Run; deleting plan retains accepted Run");
  const busy = await createSession("定时排队验收");
  report.busySessionId = busy.sessionId;
  await save();
  const active = await api.acceptTurn(
    busy.sessionId,
    '这是定时任务并发验收。先调用 schedule 创建 name 为 "排队验收" 的一次性计划，prompt 必须是 "不要调用任何工具，只回复 SCHEDULE_QUEUED_OK。"，timing 为 {"kind":"after","seconds":3}。创建后立即调用 bash 执行 `sleep 35; printf SCHEDULE_GATE_DONE`（超时设为 90 秒），等待工具完成，最后回复 BUSY_ROOT_OK。不要额外创建计划。',
    newIdempotencyKey("schedule-busy"),
  );
  assert.equal(active.kind, "run");
  const pending = await plan(busy, "排队验收");
  const queued = await scheduledRun(busy, pending.id);
  assert.equal(queued.state, "queued");
  assert(!terminal(await api.getRun(active.runId)));
  await until(async () => {
    if (terminal(await api.getRun(active.runId))) throw Error("Root finished before the Bash gate");
    return (await api.getConversation(busy.sessionId)).turns
      .find((t) => t.runId === active.runId)
      ?.transcript?.items.some(
        (i) => i.kind === "tool" && i.toolName === "bash" && i.status === "running",
      );
  }, "Bash gate before steer");
  const steer = await api.acceptTurn(
    busy.sessionId,
    "工具完成后，请在当前这轮最后加上 STEER_STAYS_IN_ROOT。不要创建计划，不要改变已有定时计划。",
    newIdempotencyKey("schedule-steer"),
  );
  assert.equal(steer.kind, "input");
  assert.equal(steer.runId, active.runId);
  let queue = await until(async () => {
    const q = await api.getInputQueue(busy.sessionId);
    return q.items.some((i) => i.inputId === steer.inputId) ? q : false;
  }, "Native steer projection");
  assert(!queue.items.some((i) => i.inputId === queued.turn_id));
  await api.mutateQueuedInput(
    busy.sessionId,
    steer.inputId,
    { action: "steer", revision: queue.revision },
    newIdempotencyKey("schedule-promote"),
  );
  const removed = await api.deleteSchedule(busy.sessionId, pending.id, pending.revision);
  assert.equal(removed.activeRun?.runId, queued.id);
  await completed(active.runId);
  await completed(queued.id);
  assert(
    text((await messages(active.runId)).filter((m) => m.role === "assistant")).includes(
      "STEER_STAYS_IN_ROOT",
    ),
  );
  assert(
    text((await messages(queued.id)).filter((m) => m.role === "assistant")).includes(
      "SCHEDULE_QUEUED_OK",
    ),
  );
  assert.equal((await api.listSchedules(busy.sessionId)).schedules.length, 0);
  const cold = await api.getConversation(busy.sessionId);
  assert.equal(
    cold.turns.find((t) => t.turnId === queued.turn_id)?.scheduledOrigin?.scheduleId,
    pending.id,
  );
  report.checks.busy = {
    activeRunId: active.runId,
    queuedRunId: queued.id,
    steerSameRun: true,
    directDeleteRetainsAcceptedRun: true,
    deletedPlanColdHistoryReadable: true,
  };
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 1200);
} finally {
  try {
    for (const session of sessions) {
      for (;;) {
        const list = await api.listSchedules(session.sessionId);
        if (!list.schedules.length) break;
        for (const p of list.schedules)
          await api.deleteSchedule(session.sessionId, p.id, p.revision);
      }
      for (const r of await rows(session.sessionId)) {
        if (!terminal(await api.getRun(r.id))) {
          await api.cancelTurn(session.sessionId, r.turn_id, newIdempotencyKey("schedule-cleanup"));
          await settled(r.id);
        }
      }
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
      await api.deleteWorkspace(
        project.workspaceId,
        newIdempotencyKey("schedule-workspace-cleanup"),
      );
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Confirmed physical Workspace purge",
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
  await save();
  console.log(JSON.stringify(report));
  if (failure) throw failure;
}
