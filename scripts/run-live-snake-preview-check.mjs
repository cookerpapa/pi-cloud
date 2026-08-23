import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { DEFAULT_EXCLUSIVE_WORKING_DIRECTORY } from "../packages/protocol/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

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

async function chromeBinary() {
  for (const candidate of [
    process.env.PI_CLOUD_CHROME_BINARY,
    "google-chrome",
    "chromium",
    "chromium-browser",
  ]) {
    if (candidate === undefined) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("A Chrome/Chromium binary is required for Snake interaction acceptance");
}

async function connectCdp(portNumber) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${String(portNumber)}/json`).then((response) =>
        response.json(),
      );
      const page = targets.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolvePromise, rejectPromise) => {
          socket.once("open", resolvePromise);
          socket.once("error", rejectPromise);
        });
        let nextId = 0;
        const pending = new Map();
        socket.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (message.id === undefined || !pending.has(message.id)) return;
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error === undefined) request.resolve(message.result);
          else request.reject(new Error(message.error.message));
        });
        return {
          socket,
          send(method, params = {}) {
            return new Promise((resolvePromise, rejectPromise) => {
              const id = ++nextId;
              pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        };
      }
    } catch {
      await wait(100);
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function exerciseGame({ username, password, previewPath, screenshotPath }) {
  const browserBinary = await chromeBinary();
  const profile = await mkdtemp(resolve(tmpdir(), "pi-cloud-snake-chrome-"));
  const debuggingPort = 9_300 + Math.floor(Math.random() * 300);
  const chrome = spawn(
    browserBinary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${String(debuggingPort)}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let cdp;
  try {
    cdp = await connectCdp(debuggingPort);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1_280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: baseUrl.toString() });
    await wait(800);
    const login = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `fetch("/v1/auth/login", {method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify(${JSON.stringify({ username, password })})}).then(response => response.status)`,
    });
    assert.equal(login.result.value, 200, "Chrome login failed");
    await cdp.send("Page.navigate", { url: new URL(previewPath, baseUrl).toString() });
    const readyDeadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < readyDeadline && !ready) {
      await wait(100);
      const result = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression:
          'Boolean(document.querySelector("#game-canvas") && document.querySelector("#start-button") && typeof window.__snakeTestState === "function")',
      });
      ready = result.result.value === true;
    }
    assert(ready, "Snake page did not expose its required controls and test state");
    const before = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: "window.__snakeTestState()",
    });
    await cdp.send("Runtime.evaluate", {
      expression: 'document.querySelector("#start-button").click()',
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
      code: "ArrowDown",
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowDown",
      code: "ArrowDown",
    });
    await wait(650);
    const after = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: "window.__snakeTestState()",
    });
    assert.equal(after.result.value.running, true, "Snake did not enter its running state");
    assert(
      after.result.value.tick > before.result.value.tick ||
        after.result.value.headX !== before.result.value.headX ||
        after.result.value.headY !== before.result.value.headY,
      "Snake head did not move after starting the game",
    );
    await cdp.send("Runtime.evaluate", {
      expression: 'document.querySelector("#pause-button").click()',
    });
    const paused = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: "window.__snakeTestState()",
    });
    assert.equal(paused.result.value.running, false, "Pause button did not stop the game loop");
    await cdp.send("Runtime.evaluate", {
      expression: 'document.querySelector("#reset-button").click()',
    });
    const reset = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: "window.__snakeTestState()",
    });
    assert.equal(reset.result.value.score, 0, "Reset button did not reset the score");
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    return {
      before: before.result.value,
      after: after.result.value,
      paused: paused.result.value,
      reset: reset.result.value,
    };
  } finally {
    cdp?.socket.close();
    chrome.kill("SIGTERM");
    await rm(profile, { recursive: true, force: true });
  }
}

const suffix = Date.now().toString(36);
const username = `snake.acceptance.${suffix}`.slice(0, 48);
const password = `Snake acceptance ${suffix} 9!`;
const browser = new BrowserCookieFetch();
const api = new PiCloudApi(browser.fetch);
const screenshotPath = resolve(tmpdir(), "pi-cloud-snake-preview-latest.png");

progress("registering browser account and creating exclusive Cube");
const registration = await api.registerAccount(username, "Snake Acceptance", password);
const development = await api.createDevelopmentEnvironment(
  "standard",
  newIdempotencyKey("environment"),
);
await waitForEnvironment(api, development.environmentId, "running");
const session = await api.createSession(
  development.projectId,
  development.workspaceId,
  `Snake preview acceptance ${suffix}`,
  "persistent",
  "standard",
  DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
);

progress("asking the real model to build, test and serve Snake");
const coding = await runCodingTurn(api, browser, session.sessionId);
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
  screenshotPath,
  conversationRetainedForInspection: true,
  systemPromptModified: false,
  modelOutputTranslated: false,
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/snake-preview-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
