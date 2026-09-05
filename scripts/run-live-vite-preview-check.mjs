import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { format } from "prettier";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_VITE_PREVIEW_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_VITE_PREVIEW_CHECK=1 to acknowledge real model and Cube usage",
  );
const env = Object.fromEntries(
  (await readFile("deploy/production/runtime/.env", "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`;
const suffix = Date.now().toString(36),
  username = `vite.acceptance.${suffix}`,
  password = `Vite acceptance ${suffix} !9`;
let cookie = "";
const api = new PiCloudApi(async (path, init = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...(cookie ? { cookie } : {}) },
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith("pi_cloud_session=")) cookie = value.split(";")[0];
  return response;
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let project, session;
const runs = [];
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeDirty:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  checkedAt: new Date().toISOString(),
};
async function run(prompt) {
  const start = Date.now();
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("vite-turn"),
    "off",
  );
  for (let poll = 0; poll < 1920; poll++) {
    const current = await api.getRun(accepted.runId);
    if (current.state === "completed") {
      runs.push({ runId: accepted.runId, elapsedMs: Date.now() - start });
      return;
    }
    if (["failed", "cancelled", "timed_out", "superseded"].includes(current.state))
      throw new Error(`Vite Run failed: ${JSON.stringify(current.failure)}`);
    await sleep(250);
  }
  throw new Error("Vite model Run timed out");
}
try {
  await api.registerAccount(username, "Vite Acceptance", password);
  project = await api.createProject(`Vite preview ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Vite preview ${suffix}`,
    "elastic",
    "standard",
    "/workspace",
    { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off", fastMode: false },
  );
  console.log("[vite-preview] generating Vite + SSE/WebSocket services with a real model");
  await run(
    [
      "Create a minimal Vite 7.3.6 vanilla-JS application in the current workspace and a separate Node HTTP/WebSocket test API (install ws@8.21.1). No subagents or web search.",
      "index.html must use a root-absolute module URL /src/main.js. That module must import ./style.css, assign window.__previewInstance=String(Date.now()), display heading #app with text VITE_READY, and a #increment button that increments #count from 0.",
      "src/style.css must initially set #app color to rgb(101,101,101). Do not configure a special Vite base URL or HMR host/port; use ordinary Vite defaults.",
      "API GET / returns simple HTML containing API_READY. GET /echo returns JSON {cookie: request.headers.cookie || ''}. GET /events sends SSE data: first immediately, flushes headers, then sends data: last and ends after 1500ms. WebSocket /socket echoes text and binary frames.",
      "Install dependencies. Start Vite on 0.0.0.0:5173 and the API on 0.0.0.0:5174 as detached background services with redirected stdin/stdout/stderr. Verify both with curl. Call preview for both ports. Do not modify files outside this workspace except temporary logs.",
    ].join(" "),
  );
  await withChromePage(
    {
      profilePrefix: "pi-cloud-vite-acceptance-",
      additionalArguments: ["--host-resolver-rules=MAP *.preview.localhost 127.0.0.1"],
    },
    async (page) => {
      await page.navigate(base);
      assert.equal(
        await page.evaluate(
          `fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username, password })})}).then(r=>r.status)`,
        ),
        200,
      );
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "window.__violations=[];document.addEventListener('securitypolicyviolation',event=>window.__violations.push(event.violatedDirective));",
      });
      await page.navigate(`${base}/v1/conversations/${session.sessionId}/preview/5173/`, 1000);
      await page.waitFor(
        "window.__previewInstance && getComputedStyle(document.querySelector('#app')).color==='rgb(101, 101, 101)'",
        30000,
      );
      assert.equal(await page.evaluate("location.pathname"), "/");
      assert.equal(await page.evaluate("document.cookie.includes('pi_cloud_preview')"), false);
      const instance = await page.evaluate("window.__previewInstance");
      await page.evaluate("document.querySelector('#increment').click()");
      assert.equal(await page.evaluate("document.querySelector('#count').textContent"), "1");
      console.log("[vite-preview] real browser loaded root modules and dynamic CSS; testing HMR");
      await run(
        "Only overwrite src/style.css to set #app color to rgb(17, 123, 45). Do not restart any service or change other files. No other task.",
      );
      await page.waitFor(
        "getComputedStyle(document.querySelector('#app')).color==='rgb(17, 123, 45)'",
        30000,
      );
      assert.equal(
        await page.evaluate("window.__previewInstance"),
        instance,
        "CSS update reloaded the document instead of HMR",
      );
      assert.equal(await page.evaluate("document.querySelector('#count').textContent"), "1");
      assert.deepEqual(await page.evaluate("window.__violations"), []);
      report.hmrWithoutReload = true;
      await page.navigate(`${base}/v1/conversations/${session.sessionId}/preview/5174/`, 1000);
      await page.waitFor("document.body.innerText.includes('API_READY')", 30000);
      const echo = await page.evaluate("fetch('/echo').then(r=>r.json())");
      assert(
        !echo.cookie.includes("pi_cloud"),
        "Platform or Preview cookie leaked to the application",
      );
      report.sse = await page.evaluate(
        `(async()=>{const start=performance.now();const response=await fetch('/events');const reader=response.body.getReader();const first=await reader.read();const firstMs=performance.now()-start;let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value)}return{first:new TextDecoder().decode(first.value),rest,firstMs:Math.round(firstMs),totalMs:Math.round(performance.now()-start)}})()`,
      );
      assert(
        report.sse.first.includes("first") && !report.sse.first.includes("last"),
        "SSE was buffered until completion",
      );
      assert(report.sse.rest.includes("last"));
      report.websocket = await page.evaluate(
        `new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/socket');ws.binaryType='arraybuffer';ws.onopen=()=>ws.send(new Uint8Array([0,255,65,13,10]));ws.onmessage=event=>{const bytes=Array.from(new Uint8Array(event.data));ws.close();resolve(bytes)};ws.onerror=()=>reject(new Error('WebSocket failed'))})`,
      );
      assert.deepEqual(report.websocket, [0, 255, 65, 13, 10]);
      assert.deepEqual(await page.evaluate("window.__violations"), []);
      report.cookieIsolation = true;
      report.rootApplicationRouting = true;
    },
  );
  report.accepted = true;
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  report.runs = runs;
  console.log(
    "[vite-preview] root routing, CSS HMR, binary WebSocket, SSE and cookie isolation passed",
  );
} finally {
  if (session)
    await api.deleteConversation(session.sessionId, newIdempotencyKey("delete-vite-session"));
  if (project)
    await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete-vite-workspace"));
}
report.resourcesDeleted = true;
await writeFile(
  "docs/reports/vite-preview-acceptance-latest.json",
  await format(JSON.stringify(report), { parser: "json" }),
);
console.log(JSON.stringify(report));
