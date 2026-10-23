import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";

if (process.env.PI_CLOUD_LIVE_QUEUE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_QUEUE_CHECK=1 to use Luna, a test account and a disposable Cube Workspace",
  );
const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const base = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const suffix = randomBytes(5).toString("hex");
let tenant, api;
const markers = {
  first: `FIRST_${suffix}`,
  edited: `EDITED_${suffix}`,
  second: `SECOND_${suffix}`,
  removed: `REMOVED_${suffix}`,
  steer: `STEER_${suffix}`,
};
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
  browserActions: [],
};
const terminal = (r) => ["completed", "cancelled", "failed", "timed_out"].includes(r.state);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let project, session, first, a, b, c, promoted, failure;
try {
  tenant = await createPrivateTenant(db, {
    slug: "native-input-" + suffix,
    ownerDisplayName: "Composer acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  api = new PiCloudApi(
    (path, init = {}) =>
      fetch(new URL(String(path), base), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30000),
      }),
    tenant.credential.token,
  );
  project = await api.createProject(`Queue acceptance ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Queue acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  console.log(JSON.stringify({ phase: "composer live fixture", ...report.resources }));
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-queued-inputs-live.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await withChromePage({}, async (page) => {
    try {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
        window.queueReads=0;window.queueAdmissions=[];window.inputRaceArmed=false;window.releaseInputMetadata=[];
        const originalFetch=window.fetch.bind(window);
        window.fetch=async(input,init)=>{
          const url=typeof input==='string'?input:input.url;
          if(new URL(url,location.href).pathname.endsWith('/queued-inputs') && (init?.method??'GET')==='GET')window.queueReads++;
          const response=await originalFetch(input,init);
          const path=new URL(url,location.href).pathname;
          if(path.endsWith('/turns')&&init?.method==='POST'&&response.ok){
            const accepted=await response.clone().json();window.queueAdmissions.push(accepted);
            if(window.inputRaceArmed&&accepted.kind==='run')await new Promise(resolve=>{window.releaseAcceptedPost=resolve;});
          }
          if(window.inputRaceArmed&&/^\\/v1\\/conversations\\/[^/]+$/.test(path)&&(init?.method??'GET')==='GET'&&response.ok)
            await new Promise(resolve=>window.releaseInputMetadata.push(resolve));
          return response;
        };
      `,
      });
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: "Bearer " + tenant.credential.token },
      });
      await page.navigate(base);
      await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
      const setValue = async (selector, value) => {
        await page.evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`,
        );
      };
      await page.navigate(`${base}/?session=${session.sessionId}`);
      await page.waitFor("document.querySelector('.product-composer textarea')");
      const firstPrompt = `Call bash exactly once with command: sleep 60; printf 'QUEUE_TOOL_OK\\n'. Keep Workspace files unchanged. After the Tool finishes reply ${markers.first}, following any later steering instruction.`;
      await page.waitFor("document.querySelector('.product-delete-conversation')");
      await setValue(".product-composer textarea", firstPrompt);
      await page.evaluate(
        "window.inputRaceArmed=true;window.promptFrames=[];window.promptObserver=new MutationObserver(()=>promptFrames.push([...document.querySelectorAll('.product-user-bubble')].map(e=>e.textContent)));promptObserver.observe(document.querySelector('.product-chat-scroll'),{subtree:true,childList:true,characterData:true});document.querySelector('.product-send-button').click()",
      );
      await page.waitFor(
        "window.releaseAcceptedPost && window.releaseInputMetadata.length && document.querySelector('.product-run-status')",
      );
      first = await page.evaluate("queueAdmissions[0]");
      assert.equal(first.kind, "run");
      assert.equal(
        await page.evaluate("document.querySelector('.product-user-bubble')===null"),
        true,
        "Early live execution must not fabricate user input",
      );
      await page.evaluate(
        "window.inputRaceArmed=false;releaseAcceptedPost();releaseInputMetadata.forEach(resolve=>resolve())",
      );
      await page.waitFor(
        `document.querySelector('.product-user-bubble')?.textContent===${JSON.stringify(firstPrompt)}`,
      );
      assert.equal(
        await page.evaluate(
          "promptFrames.flat().every(text=>text===" + JSON.stringify(firstPrompt) + ")",
        ),
        true,
      );
      await page.evaluate("promptObserver.disconnect()");
      report.initialPromptNeverFabricated = true;
      await until(
        () => api.getConversation(session.sessionId),
        (view) =>
          view.turns
            .find((t) => t.turnId === first.turnId)
            ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running"),
        "active Tool",
      );
      await setValue(
        ".product-composer textarea",
        `This is a separate task. Use no tools and reply exactly ORIGINAL_${suffix}.`,
      );
      await page.evaluate(
        "document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
      );
      await page.waitFor(
        "queueAdmissions.length===2 && document.querySelector('.product-stop-button') && document.querySelectorAll('.pending-input-row').length===1",
      );
      a = await page.evaluate("queueAdmissions[1]");
      assert.equal(a.delivery, "follow_up");
      report.composerEnterFollowUp = true;
      const beforePush = await page.evaluate("window.queueReads");
      b = await api.acceptTurn(
        session.sessionId,
        `This is a separate task. Use no tools and reply exactly ${markers.second}.`,
        newIdempotencyKey("turn"),
      );
      c = await api.acceptTurn(
        session.sessionId,
        `Reply ${markers.removed}.`,
        newIdempotencyKey("turn"),
      );
      promoted = await api.acceptTurn(
        session.sessionId,
        "A message that will be edited and steered.",
        newIdempotencyKey("turn"),
      );
      await page.waitFor(
        "document.querySelectorAll('.pending-input-row').length===3 && document.querySelector('.pending-input-queue header button[aria-expanded=false]')",
      );
      await page.evaluate("document.querySelector('.pending-input-queue header button').click()");
      await page.waitFor("document.querySelectorAll('.pending-input-row').length===4");
      assert.equal(
        await page.evaluate("window.queueReads"),
        beforePush,
        "Other-client queue changes must arrive through SSE",
      );
      report.otherClientPush = true;
      await page.send("Page.reload", { ignoreCache: true });
      await page.waitFor(
        "document.querySelectorAll('.pending-input-row').length===3 && document.querySelector('.pending-input-queue header button[aria-expanded=false]')",
      );
      await page.evaluate("document.querySelector('.pending-input-queue header button').click()");
      await page.waitFor("document.querySelectorAll('.pending-input-row').length===4");
      await wait(1000);
      const afterReconnect = await page.evaluate("window.queueReads");
      await wait(4500);
      assert.equal(
        await page.evaluate("window.queueReads"),
        afterReconnect,
        "Reconnected queue must not poll",
      );
      report.reconnectedQueue = true;
      report.idleBrowserQueueReads = 0;
      const row = (id) => `.pending-input-row[data-input-id="${id}"]`;
      const click = async (selector, text) => {
        if (
          selector.startsWith(".pending-input-row") &&
          ["编辑", "上移", "下移", "取消发送"].includes(text)
        ) {
          await page.evaluate(
            `document.querySelector(${JSON.stringify(selector)}).querySelector('[aria-haspopup="menu"]').click()`,
          );
          await page.waitFor(
            `document.querySelector(${JSON.stringify(selector)}).querySelector('[role="menu"]')`,
          );
        }
        const expression = `(()=>{const r=document.querySelector(${JSON.stringify(selector)});const b=r&&Array.from(r.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});return b&&!b.disabled;})()`;
        await page.waitFor(expression);
        await page.evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)});Array.from(r.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click();})()`,
        );
        report.browserActions.push(text);
      };
      const edit = async (id, text) => {
        await click(row(id), "编辑");
        await page.waitFor("document.querySelector('.pending-input-editor textarea')");
        await setValue(".pending-input-editor textarea", text);
      };
      const editedText = `This is a separate task. Use no tools and reply exactly ${markers.edited}.`;
      await edit(a.inputId, editedText);
      await click(".pending-input-editor", "保存");
      await page.waitFor("!document.querySelector('.pending-input-editor')");
      await click(row(b.inputId), "上移");
      await page.waitFor(
        `document.querySelector('.pending-input-row')?.dataset.inputId===${JSON.stringify(b.inputId)}`,
      );
      await click(row(c.inputId), "取消发送");
      await page.waitFor(`!document.querySelector(${JSON.stringify(row(c.inputId))})`);
      await edit(
        promoted.inputId,
        `For the current task, include ${markers.steer} in your final answer after the Tool finishes. No additional tools are needed.`,
      );
      await click(".pending-input-editor", "引导");
      await page.waitFor("!document.querySelector('.pending-input-editor')");
      await page.screenshot("/tmp/pi-cloud-queue-live.png");
      for (const accepted of [a, b, c, promoted]) {
        assert.equal(accepted.kind, "input");
        assert.equal(accepted.runId, first.runId);
      }
      const run = await until(() => api.getRun(first.runId), terminal, "native family completion");
      assert.equal(run.state, "completed", JSON.stringify(run.failure));
      report.runs.push({ runId: run.runId, state: run.state, workerId: run.workerId });
      await until(
        () => api.getInputQueue(session.sessionId),
        (q) => !q.items.length,
        "empty queue",
      );
      const view = await api.getConversation(session.sessionId);
      assert.equal(view.turns.length, 1, "Follow-up must stay within the original Run");
      const items = view.turns[0].transcript.items;
      assert.deepEqual(
        items.filter((i) => i.kind === "user").map((i) => i.inputId),
        [promoted.inputId, b.inputId, a.inputId],
      );
      assert(!items.some((i) => i.kind === "user" && i.inputId === c.inputId));
      const answers = items
        .filter((i) => i.kind === "text")
        .map((i) => i.text)
        .join("\n");
      for (const marker of [markers.steer, markers.second, markers.edited])
        assert(answers.includes(marker));
      assert(answers.indexOf(markers.second) < answers.indexOf(markers.edited));
      report.sameNativeRun = true;
      await page.waitFor("!document.querySelector('.pending-input-row')");
      report.queueEdited = true;
      report.executionOrderCorrect = true;
      report.cancelNeverAdmitted = true;
      report.editedSteerConsumed = true;
      report.noDuplicateSourceRun = true;
      const stopRun = await api.acceptTurn(
        session.sessionId,
        "Call bash exactly once with command sleep 60. Then reply DONE. No other tools.",
        newIdempotencyKey("turn"),
      );
      await until(
        () => api.getConversation(session.sessionId),
        (v) =>
          v.turns
            .find((t) => t.turnId === stopRun.turnId)
            ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running"),
        "second active Tool",
      );
      const returnedText = "Queued instruction to return after Stop " + suffix;
      await setValue(".product-composer textarea", returnedText);
      await page.evaluate("document.querySelector('.product-send-button').click()");
      await page.waitFor(
        "document.querySelector('.product-stop-button') && document.querySelector('.pending-input-row')",
      );
      await setValue(".product-composer textarea", "Unsent draft");
      await page.evaluate(
        "document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))",
      );
      await page.waitFor(
        `document.querySelector('.product-composer textarea').value===${JSON.stringify("Unsent draft\n\n" + returnedText)}`,
        90000,
      );
      const stopped = await until(
        () => api.getRun(stopRun.runId),
        terminal,
        "stopped native family",
      );
      assert.equal(stopped.state, "cancelled");
      report.stopRestoresQueueAlongsideDraft = true;
      report.runs.push({ runId: stopped.runId, state: stopped.state, workerId: stopped.workerId });
      report.accepted = true;
    } finally {
      await page
        .evaluate(
          "fetch('/v1/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(()=>true).catch(()=>false)",
        )
        .catch(() => {});
    }
  });
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  try {
    if (session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, (id) =>
        until(() => api.getRun(id), terminal, "cleanup completion"),
      );
      await until(
        () =>
          db
            .selectFrom("runs")
            .select("id")
            .where("session_id", "=", session.sessionId)
            .where("output_seal_id", "is not", null)
            .where("output_sealed_at", "is", null)
            .execute(),
        (rows) => !rows.length,
        "writer closure",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
      await until(
        () =>
          db
            .selectFrom("workspaces")
            .select("storage_purged_at")
            .where("id", "=", project.workspaceId)
            .executeTakeFirst(),
        (row) => !!row?.storage_purged_at,
        "physical Workspace purge",
      );
    }
    if (tenant) {
      await until(
        () =>
          db
            .selectFrom("outbox")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where("published_at", "is", null)
            .execute(),
        (rows) => !rows.length,
        "owned controls",
      );
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
  } catch (error) {
    errors.push(error);
  }
  await db.destroy();
  report.cleanupCompleted = errors.length === 0;
  if (failure) report.failure = failure instanceof Error ? failure.message : String(failure);
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-queued-inputs-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (failure || errors.length)
    throw new AggregateError([failure, ...errors].filter(Boolean), "Queue acceptance failed");
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    browserActions: report.browserActions.length,
    executedRuns: report.runs.length,
    cleanupCompleted: report.cleanupCompleted,
  }),
);
