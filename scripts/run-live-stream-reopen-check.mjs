import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { SseFrameParser } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_STREAM_REOPEN_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_STREAM_REOPEN_CHECK=1 for real model/browser diagnostics");
const root = new URL("..", import.meta.url).pathname;
const out = resolve(root, process.env.PI_CLOUD_REOPEN_OUTPUT ?? ".cache/stream-reopen");
await mkdir(out, { recursive: true });
const env = Object.fromEntries(
  (await readFile(resolve(root, "deploy/production/runtime/.env"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`;
let cookie;
const api = new PiCloudApi(async (url, init = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(new URL(url, base), { ...init, headers });
  const value = response.headers.getSetCookie().find((v) => v.startsWith("pi_cloud_session="));
  if (value) cookie = value.split(";")[0];
  return response;
});
const suffix = Date.now().toString(36);
const username = `stream.reopen.${suffix}`;
const password = randomUUID();
await api.registerAccount(username, "Stream Reopen Check", password);
const identity = await api.getIdentity();
const sessions = [];
const requests = new Map();
const cases = [];
const now = () => Math.round(performance.now());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error("Reopen diagnostic condition timed out");
}
let project;
let failure;
try {
  project = await api.createProject(`Stream Reopen ${suffix}`);
  for (const provider of ["deepseek", "openai-codex"]) {
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      `${provider} reopen ${suffix}`,
      "elastic",
      "starter",
      "/workspace",
      {
        provider,
        modelId: provider === "deepseek" ? "deepseek-v4-flash" : "gpt-5.6-sol",
        thinkingLevel: provider === "deepseek" ? "off" : "medium",
        fastMode: false,
      },
    );
    sessions.push(session);
    const accepted = await api.acceptTurn(
      session.sessionId,
      "Do not call any tools. Reply with exactly REOPEN-READY.",
      newIdempotencyKey("turn"),
    );
    await until(async () => {
      const run = await api.getRun(accepted.runId);
      if (["failed", "cancelled", "timed_out"].includes(run.state))
        throw new Error(`Seed Run failed: ${JSON.stringify(run.failure)}`);
      return run.state === "completed";
    });
  }
  await writeFile(
    resolve(out, "scope.json"),
    JSON.stringify({
      tenantId: identity.tenantId,
      username,
      sessions: sessions.map((s) => s.sessionId),
      projectId: project.projectId,
      workspaceId: project.workspaceId,
    }),
    { mode: 0o600 },
  );
  await withChromePage(
    { profilePrefix: "pi-cloud-reopen-", width: 1440, height: 960 },
    async (page) => {
      const parsers = new Map();
      function consume(id, data) {
        if (!data) return;
        const entry = requests.get(id);
        try {
          for (const frame of parsers.get(id).push(Buffer.from(data, "base64").toString("utf8"))) {
            const value = JSON.parse(frame.data);
            entry.frames.push({
              at: now(),
              type: frame.event,
              seq: value.seq,
              kind: frame.event === "stream.begin" ? value.kind : undefined,
            });
          }
        } catch (error) {
          entry.captureError = error.message;
        }
      }
      page.onNetworkEvent((method, p) => {
        if (
          method === "Network.requestWillBeSent" &&
          new URL(p.request.url).pathname.endsWith("/events")
        ) {
          requests.set(p.requestId, {
            id: p.requestId,
            url: p.request.url,
            start: now(),
            frames: [],
          });
          parsers.set(p.requestId, new SseFrameParser());
        }
        const entry = requests.get(p.requestId);
        if (!entry) return;
        if (method === "Network.responseReceived") {
          entry.status = p.response.status;
          entry.responseAt = now();
          void page
            .send("Network.streamResourceContent", { requestId: p.requestId })
            .then((r) => consume(p.requestId, r.bufferedData))
            .catch((e) => {
              entry.captureError = e.message;
            });
        }
        if (method === "Network.dataReceived") consume(p.requestId, p.data);
        if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          entry.end = now();
          entry.endKind = method;
          entry.error = p.errorText;
        }
      });
      await page.navigate(base);
      await page.waitFor('document.querySelector(".product-auth-card")');
      await page.evaluate(
        `(()=>{for(const [selector,value] of ${JSON.stringify([
          ['input[autocomplete="username"]', username],
          ['input[type="password"]', password],
        ])}){const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));}})()`,
      );
      await page.evaluate(
        'document.querySelector(".product-auth-card button[type=submit]").click()',
      );
      await page.waitFor('document.querySelectorAll(".product-conversation-row").length>=2');
      async function measure(label, operation, settle = 650) {
        const expectedRequests = label.startsWith("injected-snapshot-input-race-") ? 2 : 1;
        const prior = new Set(requests.keys());
        const start = now();
        await operation();
        await page.waitFor(
          'document.querySelector(".product-conversation-row.active > button:first-child")?.disabled===false',
          30000,
        );
        await wait(settle);
        const ids = [...requests.keys()].filter((id) => !prior.has(id));
        const active = [...requests.values()].filter((r) => !r.end).map((r) => r.id);
        const result = {
          label,
          expectedRequests,
          start,
          end: now(),
          ids,
          active,
          visibleTurns: await page.evaluate('document.querySelectorAll(".product-turn").length'),
        };
        cases.push(result);
        if (ids.length !== expectedRequests || active.length !== 1)
          console.log("UNEXPECTED", JSON.stringify(result));
        else if (expectedRequests === 2) console.log("EXPECTED-RECONNECT", JSON.stringify(result));
        if (cases.length % 10 === 0) console.log("PROGRESS", cases.length);
        await writeFile(
          resolve(out, "diagnostics.json"),
          JSON.stringify({ cases, requests: [...requests.values()] }, null, 2),
        );
      }
      async function open(index) {
        assert(
          await page.evaluate(
            `(()=>{const e=[...document.querySelectorAll(".product-conversation-row > button:first-child")].find(e=>e.textContent.includes(${JSON.stringify(sessions[index].title)}));if(!e||e.disabled)return false;e.click();return true})()`,
          ),
        );
      }
      const timingOnly = process.argv.includes("--timing-only");
      for (let i = 0; i < (timingOnly ? 0 : 60); i++)
        await measure(`settled-reopen-${i}`, () => open(i < 30 ? 0 : i % 2));
      for (let i = 0; i < (timingOnly ? 0 : 10); i++)
        await measure(`page-refresh-${i}`, () =>
          page.navigate(`${base}/?session=${sessions[i % 2].sessionId}`, 0),
        );
      for (let i = 0; i < (timingOnly ? 0 : 20); i++) {
        const index = i % 2;
        await measure(`select-before-reply-${i}`, () => open(index), 100);
        await page.evaluate(
          `(()=>{const e=document.querySelector(".product-composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,${JSON.stringify("Do not call tools. Reply with exactly REOPEN-READY.")});e.dispatchEvent(new InputEvent("input",{bubbles:true}));})()`,
        );
        const before = await api.getConversation(sessions[index].sessionId);
        await page.waitFor('document.querySelector(".product-send-button")?.disabled===false');
        await page.evaluate('document.querySelector(".product-send-button").click()');
        await until(async () => {
          const c = await api.getConversation(sessions[index].sessionId);
          const turn = c.turns.at(-1);
          if (c.turns.length <= before.turns.length) return false;
          if (["failed", "cancelled"].includes(turn.state))
            throw new Error(`Reply ${i} ${turn.state}`);
          return turn.state === "completed";
        });
        await page.waitFor(
          'document.querySelector(".product-model-menu-trigger")?.disabled===false',
        );
        await measure(`fresh-completed-reopen-${i}`, () => open(index));
      }
      if (timingOnly) {
        for (let i = 0; i < 6; i++) {
          const index = i % 2;
          await measure(`stream-select-${i}`, () => open(index));
          const accepted = await api.acceptTurn(
            sessions[index].sessionId,
            "Do not call tools. Write 150 numbered short lines about counting. Include every line, without abbreviating. End with STREAM-DONE.",
            newIdempotencyKey("turn"),
          );
          for (let n = 0; n < 12; n++)
            await measure(`streaming-reopen-${i}-${n}`, () => open(index), 100);
          await until(async () => {
            const run = await api.getRun(accepted.runId);
            if (["failed", "cancelled", "timed_out"].includes(run.state))
              throw new Error(`Streaming Run ${run.state}`);
            return run.state === "completed";
          });
          await measure(`stream-finished-${i}`, () => open(index));
        }
        // Delay one browser response, not the service or another user's traffic.
        // This deliberately exercises the local-input snapshot invalidation path.
        for (let i = 0; i < 3; i++) {
          const index = i % 2;
          await measure(`race-select-${i}`, () => open(index));
          await page.evaluate(
            `(()=>{const original=window.fetch;window.__reopenHold=false;window.__reopenRelease=null;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/events')&&!window.__reopenHold){window.__reopenHold=true;window.fetch=original;await new Promise(resolve=>window.__reopenRelease=resolve);}return response;};})()`,
          );
          await measure(`injected-snapshot-input-race-${i}`, async () => {
            await open(index);
            await page.waitFor("window.__reopenHold===true");
            const before = await page.evaluate('document.querySelectorAll(".product-turn").length');
            await page.evaluate(
              `(()=>{const e=document.querySelector(".product-composer textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"Do not call tools. Reply with exactly RACE-ACCEPTED.");e.dispatchEvent(new InputEvent("input",{bubbles:true}));})()`,
            );
            await page.waitFor('document.querySelector(".product-send-button")?.disabled===false');
            await page.evaluate('document.querySelector(".product-send-button").click()');
            await page.waitFor(`document.querySelectorAll(".product-turn").length>${before}`);
            await page.evaluate("window.__reopenRelease()");
          });
          await until(
            async () =>
              (await api.getConversation(sessions[index].sessionId)).turns.at(-1)?.state ===
              "completed",
          );
        }
      }
      await wait(2000);
    },
  );
} catch (error) {
  failure = error;
} finally {
  for (const session of sessions) {
    const c = await api.getConversation(session.sessionId);
    const active = c.turns.filter((t) =>
      ["accepted", "queued", "running", "cancelling"].includes(t.state),
    );
    for (const t of active)
      await api.cancelTurn(session.sessionId, t.turnId, newIdempotencyKey("cancel"));
    await until(
      async () =>
        !(await api.getConversation(session.sessionId)).turns.some((t) =>
          ["accepted", "queued", "running", "cancelling"].includes(t.state),
        ),
    );
    await api.deleteConversation(session.sessionId, newIdempotencyKey("delete"));
  }
  if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  await writeFile(
    resolve(out, "diagnostics.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        checkedAt: new Date().toISOString(),
        cases,
        requests: [...requests.values()],
        error: failure?.message,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    cases: cases.length,
    unexpected: cases.filter((c) => c.ids.length !== c.expectedRequests || c.active.length !== 1)
      .length,
  }),
);
