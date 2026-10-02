import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_QUEUE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_QUEUE_CHECK=1 to use Luna, a test account and a disposable Cube Workspace",
  );
const env = await readFile("deploy/production/runtime/.env", "utf8");
const port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`;
let cookie;
const api = new PiCloudApi(async (path, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", base);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(new URL(String(path), base), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
  for (const value of response.headers.getSetCookie()) {
    const match = /^(pi_cloud_session=[^;]*)/.exec(value);
    if (match) cookie = match[1];
  }
  return response;
});
const suffix = randomBytes(5).toString("hex"),
  username = `queue.acceptance.${suffix}`,
  password = `Queue ${randomBytes(24).toString("base64url")} 9!`;
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
  await api.registerAccount(username, "Queue acceptance", password);
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
  report.resources = { sessionId: session.sessionId, workspaceId: project.workspaceId };
  await withChromePage({}, async (page) => {
    try {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
        window.queueReads=0;
        const originalFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>{
          const url=typeof input==='string'?input:input.url;
          if(new URL(url,location.href).pathname.endsWith('/queued-inputs') && (init?.method??'GET')==='GET')window.queueReads++;
          return originalFetch(input,init);
        };
      `,
      });
      await page.navigate(base);
      await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
      await page.send("Page.reload", { ignoreCache: true });
      await page.waitFor("document.querySelector('.product-auth-card')");
      const setValue = async (selector, value) => {
        await page.evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
      };
      await setValue('input[autocomplete="username"]', username);
      await setValue('input[type="password"]', password);
      await page.evaluate(
        "document.querySelector('.product-auth-card button[type=submit]').click()",
      );
      await page.waitFor("document.querySelector('.product-shell')");
      await page.navigate(`${base}/?session=${session.sessionId}`);
      await page.waitFor("document.querySelector('.product-composer textarea')");
      first = await api.acceptTurn(
        session.sessionId,
        `Call bash exactly once with command: sleep 30; printf 'QUEUE_TOOL_OK\\n'. Keep Workspace files unchanged. After the Tool finishes reply ${markers.first}, following any later steering instruction.`,
        newIdempotencyKey("turn"),
      );
      await until(
        () => api.getConversation(session.sessionId),
        (view) =>
          view.turns
            .find((t) => t.turnId === first.turnId)
            ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running"),
        "active Tool",
      );
      const beforePush = await page.evaluate("window.queueReads");
      a = await api.acceptTurn(
        session.sessionId,
        `This is a separate task. Use no tools and reply exactly ORIGINAL_${suffix}.`,
        newIdempotencyKey("turn"),
      );
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
      await page.waitFor("document.querySelectorAll('.pending-input-row').length===4");
      assert.equal(
        await page.evaluate("window.queueReads"),
        beforePush,
        "Other-client queue changes must arrive through SSE",
      );
      report.otherClientPush = true;
      await page.send("Page.reload", { ignoreCache: true });
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
      const row = (id) => `.pending-input-row[data-turn-id="${id}"]`;
      const click = async (selector, text) => {
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
      await edit(a.turnId, editedText);
      await click(".pending-input-editor", "保存");
      await page.waitFor("!document.querySelector('.pending-input-editor')");
      await click(row(b.turnId), "↑");
      await page.waitFor(
        `document.querySelector('.pending-input-row')?.dataset.turnId===${JSON.stringify(b.turnId)}`,
      );
      await click(row(c.turnId), "取消发送");
      await page.waitFor(`!document.querySelector(${JSON.stringify(row(c.turnId))})`);
      await edit(
        promoted.turnId,
        `For the current task, include ${markers.steer} in your final answer after the Tool finishes. No additional tools are needed.`,
      );
      await click(".pending-input-editor", "立即引导");
      await page.waitFor("!document.querySelector('.pending-input-editor')");
      await page.screenshot("/tmp/pi-cloud-queue-live.png");
      for (const accepted of [first, b, a]) {
        const run = await until(() => api.getRun(accepted.runId), terminal, "Run completion");
        assert.equal(run.state, "completed", JSON.stringify(run.failure));
        report.runs.push({
          runId: run.runId,
          state: run.state,
          workerId: run.workerId,
          startedAt: run.startedAt,
          settledAt: run.settledAt,
        });
      }
      assert(Date.parse(report.runs[1].startedAt) >= Date.parse(report.runs[0].settledAt));
      assert(Date.parse(report.runs[2].startedAt) >= Date.parse(report.runs[1].settledAt));
      await until(
        () => api.getInputQueue(session.sessionId),
        (q) => q.items.length === 0,
        "empty queue",
      );
      const removed = await api.getRun(c.runId),
        steered = await api.getRun(promoted.runId);
      assert.equal(removed.state, "cancelled");
      assert.equal(removed.workerId, undefined);
      assert.equal(steered.state, "cancelled");
      assert.equal(steered.workerId, undefined);
      assert.equal(steered.stopReason, "queued_input_steered");
      const view = await api.getConversation(session.sessionId);
      assert.deepEqual(
        view.turns.map((t) => t.turnId),
        [first.turnId, b.turnId, a.turnId],
      );
      const text = (id) =>
        view.turns
          .find((t) => t.turnId === id)
          ?.transcript?.items.filter((i) => i.kind === "text")
          .map((i) => i.text)
          .join("")
          .trim() ?? "";
      assert(text(first.turnId).includes(markers.steer));
      assert.equal(text(b.turnId), markers.second);
      assert.equal(text(a.turnId), markers.edited);
      await page.waitFor("!document.querySelector('.pending-input-row')");
      report.queueEdited = true;
      report.executionOrderCorrect = true;
      report.cancelNeverAdmitted = true;
      report.editedSteerConsumed = true;
      report.noDuplicateSourceRun = true;
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
      const accepted = [first, a, b, c, promoted].filter(Boolean);
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const q = await api.getInputQueue(session.sessionId);
        const queued = q.items.find((i) => i.status === "queued");
        if (queued) {
          try {
            await api.mutateQueuedInput(
              session.sessionId,
              queued.turnId,
              { action: "cancel", revision: q.revision },
              newIdempotencyKey("cancel"),
            );
          } catch (e) {
            if (!(e instanceof PiCloudApiError) || e.status !== 409) throw e;
          }
        }
        if (q.activeTurnId) {
          try {
            await api.cancelTurn(session.sessionId, q.activeTurnId, newIdempotencyKey("cancel"));
          } catch (e) {
            if (!(e instanceof PiCloudApiError) || e.status !== 409) throw e;
          }
        }
        if ((await Promise.all(accepted.map((r) => api.getRun(r.runId)))).every(terminal)) break;
        await wait(200);
      }
      assert(
        (await Promise.all(accepted.map((r) => api.getRun(r.runId)))).every(terminal),
        "Test executions did not finish during cleanup",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  } catch (error) {
    errors.push(error);
  }
  try {
    await api.logout();
  } catch (error) {
    errors.push(error);
  }
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
