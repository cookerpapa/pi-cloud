import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { serviceAddress, kubectlAsync } from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_PAUSED_QUEUE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_PAUSED_QUEUE_CHECK=1 for owned Luna/queue/browser/Worker restart acceptance",
  );
const runtime = "deploy/production/runtime";
const env = await readFile(`${runtime}/.env`, "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const pg = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pg.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: pg.toString(), maxConnections: 1 });
let cookie, project, session, failure;
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
const suffix = randomBytes(5).toString("hex");
const username = `paused.queue.${suffix}`,
  password = `Queue ${randomBytes(24).toString("base64url")} 9!`;
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
const turns = [];
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function accept(prompt) {
  const turn = await api.acceptTurn(session.sessionId, prompt, newIdempotencyKey("queue"), "low");
  turns.push(turn);
  return turn;
}
async function settled(turn) {
  return until(async () => {
    const r = await api.getRun(turn.runId);
    return terminal(r) && r;
  }, "Run settlement");
}
const prompt = (text) => `This is a separate task. Use no tools. Reply exactly ${text}.`;
try {
  await api.registerAccount(username, "Paused queue acceptance", password);
  project = await api.createProject(`Paused queue ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Paused queue",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  const first = await accept(
    "Call bash exactly once: sleep 120. Then reply done. This task will be cancelled by a test.",
  );
  await until(
    async () =>
      (await api.getConversation(session.sessionId)).turns
        .find((t) => t.runId === first.runId)
        ?.transcript.items.some((i) => i.kind === "tool" && i.status === "running"),
    "active Bash",
  );
  const b = await accept(prompt(`B_${suffix}`)),
    c = await accept(prompt(`C_${suffix}`));
  const steer = await api.steerTurn(
    session.sessionId,
    first.turnId,
    prompt(`D_${suffix}`),
    newIdempotencyKey("steer"),
  );
  turns.push({ runId: steer.sourceRunId, turnId: steer.sourceTurnId });
  const stopKey = newIdempotencyKey("stop");
  await withChromePage({}, async (page) => {
    await page.navigate(base);
    await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
    await page.send("Page.reload", { ignoreCache: true });
    await page.waitFor("document.querySelector('.product-auth-card')");
    const setValue = async (selector, value) =>
      page.evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    await setValue('input[autocomplete="username"]', username);
    await setValue('input[type="password"]', password);
    await page.evaluate("document.querySelector('.product-auth-card button[type=submit]').click()");
    await page.waitFor("document.querySelector('.product-shell')");
    await page.navigate(`${base}/?session=${session.sessionId}`);
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===3");
    await api.cancelTurn(session.sessionId, first.turnId, stopKey);
    assert.equal((await settled(first)).state, "cancelled");
    const paused = await until(async () => {
      const q = await api.getInputQueue(session.sessionId);
      return q.items.length === 3 && q.items.every((i) => i.paused && i.status === "queued") && q;
    }, "paused follow-up and unconsumed steer");
    assert(paused.items.some((i) => i.turnId === steer.sourceTurnId));
    report.unconsumedSteerPaused = true;
    await page.waitFor(
      "document.querySelector('.pending-input-queue header').textContent.includes('继续队列')",
    );
    await page.send("Page.reload", { ignoreCache: true });
    await page.waitFor("document.querySelectorAll('.pending-input-status').length===3");
    report.refreshPreservedPause = true;
    const { rows } =
      await sql`select count(*)::int n from runs where state not in ('completed','failed','cancelled','timed_out')
      and session_id<>${session.sessionId}::uuid`.execute(database);
    assert.equal(
      rows[0].n,
      0,
      "Refuse Worker replacement while another Session has pending/active work",
    );
    await kubectlAsync(["rollout", "restart", "statefulset/pi-cloud-pi-worker-primary-v1"]);
    await kubectlAsync([
      "rollout",
      "status",
      "statefulset/pi-cloud-pi-worker-primary-v1",
      "--timeout=180s",
    ]);
    await delay(2000);
    assert((await api.getInputQueue(session.sessionId)).items.every((i) => i.paused));
    for (const id of [b.runId, c.runId, steer.sourceRunId])
      assert.equal((await api.getRun(id)).state, "queued");
    report.workerReplacementPreservedPause = true;
    const fresh = await accept(prompt(`FRESH_${suffix}`));
    await api.cancelTurn(session.sessionId, first.turnId, stopKey);
    assert.equal((await settled(fresh)).state, "completed");
    assert((await api.getInputQueue(session.sessionId)).items.every((i) => i.paused));
    report.freshInputBypassedPaused = true;
    const row = (id) => `.pending-input-row[data-turn-id="${id}"]`;
    const click = async (selector, text) => {
      const body = `const r=document.querySelector(${JSON.stringify(selector)});const b=r&&[...r.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});`;
      await page.waitFor(`(()=>{${body}return b&&!b.disabled;})()`);
      await page.evaluate(`(()=>{${body}b.click();})()`);
    };
    await click(row(c.turnId), "编辑");
    await page.waitFor("document.querySelector('.pending-input-editor textarea')");
    await setValue(".pending-input-editor textarea", prompt(`EDITED_${suffix}`));
    await click(".pending-input-editor", "保存");
    await page.waitFor("!document.querySelector('.pending-input-editor')");
    await click(row(c.turnId), "发送");
    assert.equal((await settled(c)).state, "completed");
    const beforeResume = await api.getInputQueue(session.sessionId);
    assert.deepEqual(
      beforeResume.items.map((i) => i.runId),
      [b.runId, steer.sourceRunId],
    );
    assert(beforeResume.items.every((i) => i.paused));
    report.singleSendPreservedOtherPauses = true;
    await click(".pending-input-queue header", "继续队列");
    assert.equal((await settled(b)).state, "completed");
    assert.equal((await settled({ runId: steer.sourceRunId })).state, "completed");
    const view = await api.getConversation(session.sessionId);
    assert.deepEqual(
      view.turns.map((t) => t.runId),
      [first.runId, fresh.runId, c.runId, b.runId, steer.sourceRunId],
    );
    for (const [id, expected] of [
      [fresh.runId, `FRESH_${suffix}`],
      [c.runId, `EDITED_${suffix}`],
      [b.runId, `B_${suffix}`],
      [steer.sourceRunId, `D_${suffix}`],
    ]) {
      const text = view.turns
        .find((t) => t.runId === id)
        .transcript.items.filter((i) => i.kind === "text")
        .map((i) => i.text)
        .join("")
        .trim();
      assert.equal(text, expected);
    }
    await page.waitFor("!document.querySelector('.pending-input-row')");
    report.browserSendAndResume = true;
    report.executionAndHistoryOrder = true;
    report.executedRuns = view.turns.length;
    report.accepted = true;
  });
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  if (session) {
    try {
      for (let attempts = 0; attempts < 120; attempts++) {
        const q = await api.getInputQueue(session.sessionId);
        const item = q.items.find((i) => i.status === "queued");
        if (item) {
          await api.mutateQueuedInput(
            session.sessionId,
            item.turnId,
            { action: "cancel", revision: q.revision },
            newIdempotencyKey("cleanup"),
          );
          continue;
        }
        if (q.activeTurnId) {
          try {
            await api.cancelTurn(session.sessionId, q.activeTurnId, newIdempotencyKey("cleanup"));
          } catch {}
          await delay(1000);
          continue;
        }
        if (q.items.length) {
          await delay(1000);
          continue;
        }
        if (
          (await Promise.all(turns.map((turn) => api.getRun(turn.runId)))).some((r) => !terminal(r))
        ) {
          await delay(1000);
          continue;
        }
        break;
      }
      await api.deleteConversation(session.sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await api.logout();
  } catch (error) {
    errors.push(error);
  }
  await database.destroy();
  report.cleanupCompleted = !errors.length;
  if (failure) report.failure = failure.message;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-paused-input-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Paused queue acceptance failed",
    );
}
