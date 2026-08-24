import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXCLUSIVE_WORKING_DIRECTORY } from "../packages/protocol/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

if (process.env.PI_CLOUD_LIVE_SNAKE_PREVIEW_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_SNAKE_PREVIEW_CHECK=1 to acknowledge real model and Cube usage",
  );
}

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
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

function progress(stage) {
  process.stdout.write(`[snake-preview-check] ${stage}\n`);
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

class BrowserCookieFetch {
  #cookie;

  get cookieHeader() {
    if (this.#cookie === undefined) throw new Error("Browser session cookie is unavailable");
    return this.#cookie;
  }

  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(300_000),
    });
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/.exec(value);
      if (match !== null) this.#cookie = match[1];
    }
    return response;
  };
}

async function waitForEnvironment(api, environmentId, expectedState) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const current = (await api.listDevelopmentEnvironments()).environments.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (current?.state === expectedState) return current;
    if (current?.state === "failed" || current?.state === "unknown") {
      throw new Error(
        `Environment reached ${current.state}: ${current.failureCode ?? "unknown failure"}`,
      );
    }
    await wait(250);
  }
  throw new Error(`Environment did not reach ${expectedState}`);
}

async function waitForRun(api, runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ended as ${run.state}: ${JSON.stringify(run.failure ?? {})}`);
    }
    await wait(100);
  }
  throw new Error("Snake coding Run did not settle");
}

async function runCodingTurn(api, browser, sessionId) {
  const prompt = [
    "Build a complete browser Snake game in the current working directory and test it.",
    "Use only HTML, CSS and vanilla JavaScript with no external dependencies.",
    "Create index.html, styles.css and app.js.",
    "The page must contain #game-canvas, #start-button, #pause-button, #reset-button and #score.",
    "Keyboard arrow keys and WASD must control the snake.",
    "Expose window.__snakeTestState() returning an object with headX, headY, score, running and tick.",
    "Serve the directory on 0.0.0.0:4173 and keep the server running after this task finishes.",
    "Use tools to inspect the files, run JavaScript syntax checks, start the server and fetch the page locally.",
    "In the final response include http://localhost:4173/ only after all checks pass.",
  ].join(" ");
  const startedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Snake coding stream timed out")),
    10 * 60_000,
  );
  const events = [];
  let terminal;
  let firstTextAt;
  try {
    const cursor = await streamSessionEvents({
      sessionId,
      afterSequence: 0,
      signal: controller.signal,
      fetchImplementation: browser.fetch,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        if (event.turnId !== accepted.turnId) return;
        events.push(event);
        if (event.type === "assistant.text.delta") firstTextAt ??= performance.now();
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          terminal = event;
          controller.abort();
        }
      },
    });
    assert(terminal, "Snake coding Run did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    const run = await waitForRun(api, accepted.runId);
    const toolStarts = events.filter((event) => event.type === "tool.started").length;
    assert(toolStarts >= 3, "Snake coding Run did not exercise the Tool path");
    return {
      accepted,
      cursor,
      events,
      run,
      firstTextMs: firstTextAt === undefined ? null : Math.round(firstTextAt - startedAt),
      settledMs: Math.round(performance.now() - startedAt),
      toolStarts,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function waitForPreview(browser, sessionId) {
  const path = `/v1/conversations/${encodeURIComponent(sessionId)}/preview/4173/`;
  const deadline = Date.now() + 90_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await browser.fetch(path, { headers: { accept: "text/html" } });
    lastStatus = response.status;
    if (response.ok) return { path, html: await response.text() };
    await wait(500);
  }
  throw new Error(`Snake preview did not become reachable; last HTTP status ${String(lastStatus)}`);
}

async function exerciseGame({ username, password, previewPath, screenshotPath }) {
  return withChromePage(
    { profilePrefix: "pi-cloud-snake-chrome-", width: 1_280, height: 900 },
    async (page) => {
      await page.navigate(baseUrl.toString(), 800);
      const login = await page.evaluate(
        `fetch("/v1/auth/login", {method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify(${JSON.stringify({ username, password })})}).then(response => response.status)`,
      );
      assert.equal(login, 200, "Chrome login failed");
      await page.navigate(new URL(previewPath, baseUrl).toString());
      await page.waitFor(
        'document.querySelector("#game-canvas") && document.querySelector("#start-button") && typeof window.__snakeTestState === "function"',
      );
      const before = await page.evaluate("window.__snakeTestState()");
      await page.evaluate('document.querySelector("#start-button").click()');
      await page.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "ArrowDown",
        code: "ArrowDown",
      });
      await page.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "ArrowDown",
        code: "ArrowDown",
      });
      await page.wait(650);
      const after = await page.evaluate("window.__snakeTestState()");
      assert.equal(after.running, true, "Snake did not enter its running state");
      assert(
        after.tick > before.tick || after.headX !== before.headX || after.headY !== before.headY,
        "Snake head did not move after starting the game",
      );
      await page.evaluate('document.querySelector("#pause-button").click()');
      const paused = await page.evaluate("window.__snakeTestState()");
      await page.wait(450);
      const pausedAfterWait = await page.evaluate("window.__snakeTestState()");
      assert.equal(pausedAfterWait.tick, paused.tick, "Pause button did not stop the game loop");
      assert.equal(pausedAfterWait.headX, paused.headX);
      assert.equal(pausedAfterWait.headY, paused.headY);
      await page.evaluate('document.querySelector("#reset-button").click()');
      const reset = await page.evaluate("window.__snakeTestState()");
      assert.equal(reset.score, 0, "Reset button did not reset the score");
      await page.screenshot(screenshotPath);
      return { before, after, paused, pausedAfterWait, reset };
    },
  );
}

const suffix = Date.now().toString(36);
const reusedSessionId = process.env.PI_CLOUD_SNAKE_REUSE_SESSION_ID;
const username =
  process.env.PI_CLOUD_SNAKE_REUSE_USERNAME ?? `snake.acceptance.${suffix}`.slice(0, 48);
const password = process.env.PI_CLOUD_SNAKE_REUSE_PASSWORD ?? `Snake acceptance ${suffix} 9!`;
if (
  reusedSessionId !== undefined &&
  (process.env.PI_CLOUD_SNAKE_REUSE_USERNAME === undefined ||
    process.env.PI_CLOUD_SNAKE_REUSE_PASSWORD === undefined)
) {
  throw new Error("Snake reuse requires username, password and Session ID together");
}
const browser = new BrowserCookieFetch();
const api = new PiCloudApi(browser.fetch);
const screenshotPath = resolve(tmpdir(), "pi-cloud-snake-preview-latest.png");

let session;
let development;
let coding;
if (reusedSessionId === undefined) {
  progress("registering browser account and creating exclusive Cube");
  await api.registerAccount(username, "Snake Acceptance", password);
  development = await api.createDevelopmentEnvironment(
    `Snake machine ${suffix}`,
    "standard",
    newIdempotencyKey("environment"),
  );
  await waitForEnvironment(api, development.environmentId, "running");
  session = await api.createSession(
    development.projectId,
    development.workspaceId,
    `Snake preview acceptance ${suffix}`,
    "persistent",
    "standard",
    DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
  );
  progress("asking the real model to build, test and serve Snake");
  coding = await runCodingTurn(api, browser, session.sessionId);
} else {
  progress("reusing a completed Snake coding Session for browser interaction recovery");
  await api.loginAccount(username, password);
  const conversation = await api.getConversation(reusedSessionId);
  const latest = conversation.turns.at(-1);
  if (latest?.state !== "completed" || latest.runId === null) {
    throw new Error("Reused Snake Session does not have a completed Run");
  }
  session = conversation.session;
  development = (await api.listDevelopmentEnvironments()).environments.find(
    (candidate) => candidate.workspaceId === conversation.session.workspaceId,
  );
  if (development === undefined || development.state !== "running") {
    throw new Error("Reused Snake development environment is not running");
  }
  coding = {
    accepted: { runId: latest.runId },
    toolStarts: latest.transcript.items.filter((item) => item.kind === "tool").length,
    firstTextMs: null,
    settledMs: null,
  };
}
const preview = await waitForPreview(browser, session.sessionId);
assert.match(preview.html, /game-canvas/);
assert.match(preview.html, /start-button/);
progress("host-authenticated preview reached the Cube service");

const interaction = await exerciseGame({
  username,
  password,
  previewPath: preview.path,
  screenshotPath,
});
progress("headless browser start, movement, pause and reset passed");

const conversation = await api.getConversation(session.sessionId);
const serializedConversation = JSON.stringify(conversation);
assert(serializedConversation.includes("http://localhost:4173/"));
const report = {
  accepted: true,
  piCloudRevision: testedRevision,
  checkedAt: new Date().toISOString(),
  account: username,
  sessionId: session.sessionId,
  workspaceId: development.workspaceId,
  developmentEnvironmentId: development.environmentId,
  runId: coding.accepted.runId,
  toolCalls: coding.toolStarts,
  firstTextMs: coding.firstTextMs,
  settledMs: coding.settledMs,
  hostPreviewStatus: 200,
  previewPath: preview.path,
  browserInteraction: interaction,
  screenshotCaptured: true,
  conversationRetainedForInspection: true,
  reusedCompletedCodingSession: reusedSessionId !== undefined,
  systemPromptModified: false,
  modelOutputTranslated: false,
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/snake-preview-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
