import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readPreviewDocument } from "./lib/preview-client.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_PREVIEW_ISOLATION_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_PREVIEW_ISOLATION_CHECK=1 to acknowledge real model and Cube usage",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const environment = parseEnvironment(await readFile(resolve(runtimeDirectory, ".env"), "utf8"));
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function progress(stage) {
  process.stdout.write(`[preview-isolation-check] ${stage}\n`);
}

class BrowserCookieFetch {
  #cookie;

  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10 * 60_000),
    });
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/u.exec(value);
      if (match !== null) this.#cookie = match[1];
    }
    return response;
  };
}

async function waitForRun(api, runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ended as ${run.state}: ${JSON.stringify(run.failure ?? {})}`);
    }
    await wait(200);
  }
  throw new Error("Application service Run did not settle");
}

async function preview(browser, sessionId, portNumber) {
  const bootstrap = await browser.fetch(
    `/v1/conversations/${sessionId}/preview/${String(portNumber)}/`,
    { headers: { accept: "*/*" }, redirect: "manual" },
  );
  assert.equal(bootstrap.status, 307);
  const location = bootstrap.headers.get("location");
  assert(location, "Preview bootstrap did not return an isolated origin");
  const publicUrl = new URL(location, baseUrl);
  const response = await readPreviewDocument(publicUrl, connectHost);
  assert.equal(response.status, 200);
  return response.body.toString("utf8");
}

function twoServicePrompt(label) {
  return [
    `Build two small services for isolation marker ${label} in the current Workspace.`,
    `Create ui/index.html whose visible body contains exactly ${label}-UI-3000.`,
    `Create api.py using only Python's standard library; GET / must return JSON containing marker ${label}-API-8000 and Access-Control-Allow-Origin: *.`,
    "Start the static UI on 0.0.0.0:3000 and the JSON API on 0.0.0.0:8000 as detached processes that survive this Turn.",
    "Verify both localhost endpoints with Python or curl.",
    "Call the preview Tool once for port 3000 and once for port 8000.",
    "Do not print localhost or invent a public URL. Keep the implementation bounded.",
  ].join(" ");
}

const suffix = Date.now().toString(36);
const password = `Preview-${suffix}-safe-password`;
const browser = new BrowserCookieFetch();
const api = new PiCloudApi(browser.fetch);
const sessionIds = [];
const workspaceIds = [];

try {
  await api.registerAccount(
    `preview.acceptance.${suffix}`.slice(0, 48),
    "Preview Isolation Acceptance",
    password,
  );
  const [projectA, projectB] = await Promise.all([
    api.createProject(`Preview A ${suffix}`),
    api.createProject(`Preview B ${suffix}`),
  ]);
  workspaceIds.push(projectA.workspaceId, projectB.workspaceId);
  const [sessionA, sessionB] = await Promise.all([
    api.createSession(projectA.projectId, projectA.workspaceId, `Preview A ${suffix}`, "elastic"),
    api.createSession(projectB.projectId, projectB.workspaceId, `Preview B ${suffix}`, "elastic"),
  ]);
  sessionIds.push(sessionA.sessionId, sessionB.sessionId);

  progress("submitting two Sessions with identical guest ports");
  const [acceptedA, acceptedB] = await Promise.all([
    api.acceptTurn(
      sessionA.sessionId,
      twoServicePrompt("SESSION-A"),
      newIdempotencyKey("turn"),
      "off",
    ),
    api.acceptTurn(
      sessionB.sessionId,
      twoServicePrompt("SESSION-B"),
      newIdempotencyKey("turn"),
      "off",
    ),
  ]);
  await Promise.all([waitForRun(api, acceptedA.runId), waitForRun(api, acceptedB.runId)]);

  const [aUi, aApi, bUi, bApi] = await Promise.all([
    preview(browser, sessionA.sessionId, 3_000),
    preview(browser, sessionA.sessionId, 8_000),
    preview(browser, sessionB.sessionId, 3_000),
    preview(browser, sessionB.sessionId, 8_000),
  ]);
  assert.match(aUi, /SESSION-A-UI-3000/u);
  assert.match(aApi, /SESSION-A-API-8000/u);
  assert.match(bUi, /SESSION-B-UI-3000/u);
  assert.match(bApi, /SESSION-B-API-8000/u);
  assert.doesNotMatch(aUi + aApi, /SESSION-B/u);
  assert.doesNotMatch(bUi + bApi, /SESSION-A/u);
  progress("same guest ports resolved to independent Session/Cube services");

  const third = await api.acceptTurn(
    sessionA.sessionId,
    [
      "Keep the existing 3000 and 8000 services running.",
      "Create third/index.html containing exactly SESSION-A-THIRD-5173.",
      "Start it as a detached static server on 0.0.0.0:5173, verify it locally, and call the preview Tool for port 5173.",
    ].join(" "),
    newIdempotencyKey("turn"),
    "off",
  );
  await waitForRun(api, third.runId);
  const [aUiAfter, aThird] = await Promise.all([
    preview(browser, sessionA.sessionId, 3_000),
    preview(browser, sessionA.sessionId, 5_173),
  ]);
  assert.match(aUiAfter, /SESSION-A-UI-3000/u);
  assert.match(aThird, /SESSION-A-THIRD-5173/u);
  progress("one Session retained three simultaneous services across Turns");

  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    workingTreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim().length > 0,
    checkedAt: new Date().toISOString(),
    sessions: 2,
    concurrentInitialRuns: 2,
    sameSessionPorts: [3_000, 8_000, 5_173],
    reusedCrossSessionPorts: [3_000, 8_000],
    crossSessionMarkerLeak: false,
  };
  await writeFile(
    resolve(repositoryRoot, "docs/reports/preview-isolation-acceptance-latest.json"),
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  for (const sessionId of sessionIds) {
    await api.deleteConversation(sessionId, newIdempotencyKey("delete")).catch(() => undefined);
  }
  for (const workspaceId of workspaceIds) {
    await api.deleteWorkspace(workspaceId, newIdempotencyKey("delete")).catch(() => undefined);
  }
}
