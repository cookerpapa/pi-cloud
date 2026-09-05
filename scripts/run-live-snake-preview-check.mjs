import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readPreviewDocument } from "./lib/preview-client.mjs";
import { readFile, rm, writeFile } from "node:fs/promises";
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
const workingTreeDirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().length > 0;

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
    "Use the write Tool for the source files rather than shell heredocs.",
    "The page must contain #game-canvas, #start-button, #pause-button, #reset-button and #score.",
    "Keyboard arrow keys and WASD must control the snake.",
    "Expose window.__snakeTestState() returning an object with headX, headY, score, running and tick.",
    "tick must be a non-negative integer that increases on every game-loop step; running must be true only while steps are advancing, false initially, false after Pause and false after Reset.",
    "Serve the directory on 0.0.0.0:4173 and keep the server running after this task finishes.",
    "Use tools to inspect the files, run JavaScript syntax checks, start the server and fetch the page locally.",
    "After all checks pass, call the preview Tool for port 4173. Do not print a localhost or guessed public URL.",
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
  let firstDurableActivityAt;
  let firstToolStartedAt;
  let firstAssistantTextAt;
  const observeEvent = (event) => {
    if (event.turnId !== accepted.turnId) return;
    if (events.some((candidate) => candidate.eventId === event.eventId)) return;
    events.push(event);
    if (event.type === "assistant.text.delta") {
      const observedAt = performance.now();
      firstDurableActivityAt ??= observedAt;
      firstAssistantTextAt ??= observedAt;
    }
    if (event.type === "tool.started") {
      const observedAt = performance.now();
      firstDurableActivityAt ??= observedAt;
      firstToolStartedAt ??= observedAt;
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      terminal = event;
      controller.abort();
    }
  };
  try {
    await streamSessionEvents({
      sessionId,
      signal: controller.signal,
      fetchImplementation: browser.fetch,
      retryDelayMs: 100,
      onStatus() {},
      onSnapshot(snapshot) {
        for (const event of snapshot.liveEvents) observeEvent(event);
      },
      onEvent: observeEvent,
    });
    assert(terminal, "Snake coding Run did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    const run = await waitForRun(api, accepted.runId);
    const toolStarts = events.filter((event) => event.type === "tool.started").length;
    assert(toolStarts >= 3, "Snake coding Run did not exercise the Tool path");
    const toolPreparations = events.filter(
      (event) => event.type === "assistant.tool_call.preparing",
    );
    assert(toolPreparations.length >= 3, "Snake coding Run did not expose Tool preparation");
    for (const preparation of toolPreparations) {
      const preparationIndex = events.indexOf(preparation);
      const startedIndex = events.findIndex(
        (event, index) =>
          index > preparationIndex &&
          (event.type === "tool.started" || event.type === "tool.completed") &&
          event.payload.toolCallId === preparation.payload.toolCallId,
      );
      assert(
        startedIndex > preparationIndex,
        "Tool preparation was not replaced by start or rejection",
      );
    }
    assert(firstDurableActivityAt !== undefined);
    assert(firstToolStartedAt !== undefined);
    assert(firstAssistantTextAt !== undefined);
    const previewToolUsed = events.some(
      (event) => event.type === "tool.started" && event.payload.toolName === "preview",
    );
    assert(previewToolUsed, "Snake coding Run did not publish its service through Preview Tool");
    return {
      accepted,
      throughSequence: Math.max(0, ...events.map((event) => event.seq)),
      events,
      run,
      firstDurableActivityMs: Math.round(firstDurableActivityAt - startedAt),
      firstToolStartedMs: Math.round(firstToolStartedAt - startedAt),
      firstAssistantTextMs: Math.round(firstAssistantTextAt - startedAt),
      settledMs: Math.round(performance.now() - startedAt),
      toolStarts,
      toolPreparations: toolPreparations.length,
      previewToolUsed,
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runCodingWithPreparationBrowser(api, browser, sessionId) {
  return withChromePage({ profilePrefix: "pi-cloud-preparation-" }, async (page) => {
    await page.navigate(baseUrl.toString());
    const login = await page.evaluate(
      `fetch('/v1/auth/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username, password })})}).then(r=>r.status)`,
    );
    assert.equal(login, 200);
    await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
    await page.navigate(new URL(`/?session=${sessionId}`, baseUrl).toString());
    await page.waitFor('document.querySelector(".product-composer textarea")');
    const run = runCodingTurn(api, browser, sessionId);
    // Preserve the model error while the independent browser observation is waiting.
    let runError;
    const settled = run.catch((error) => {
      runError = error;
    });
    try {
      await page.waitFor(
        '[...document.querySelectorAll(".product-tool-preparing")].some(row=>row.querySelector("code")?.textContent==="write" && Number(row.querySelector("small")?.textContent.match(/\\d+/)?.[0])>=3)',
        180_000,
      );
      const initial = await page.evaluate(`(()=>{
        const row=[...document.querySelectorAll('.product-tool-preparing')].find(row=>row.querySelector('code')?.textContent==='write' && Number(row.querySelector('small')?.textContent.match(/\\d+/)?.[0])>=3);
        return {id:row.dataset.toolCallId, text:row.textContent, title:row.title,
          animation:getComputedStyle(row.querySelector('.product-tool-preparing-spinner')).animationName};
      })()`);
      assert(initial.text.includes("正在准备工具调用"));
      assert(initial.title.includes("尚未执行"));
      assert.equal(initial.animation, "product-tool-preparing-spin");
      const selector = `.product-tool-preparing[data-tool-call-id=${JSON.stringify(initial.id)}]`;
      const elapsed = `Number(document.querySelector(${JSON.stringify(selector)})?.querySelector('small')?.textContent.match(/\\d+/)?.[0])`;
      const before = await page.evaluate(elapsed);
      assert(before >= 3, "Preparation clock did not advance during argument generation");
      await page.send("Page.reload", { ignoreCache: true });
      await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 30_000);
      const recovered = await page.evaluate(elapsed);
      assert(recovered >= before, "Refresh reset the preparation clock");
      progress("browser observed live Tool preparation, ticking clock and snapshot recovery");
      const result = await settled;
      if (runError) throw runError;
      await page.waitFor('document.querySelectorAll(".product-tool-preparing").length===0');
      return {
        ...result,
        preparationBrowser: { before, recovered, spinner: true, cleared: true },
      };
    } catch (error) {
      progress(`preparation browser failure: ${error.message}`);
      const result = await settled;
      if (result) {
        const spans = result.events
          .filter((event) => event.type === "assistant.tool_call.preparing")
          .map((preparation) => {
            const end = result.events.find(
              (event) =>
                (event.type === "tool.started" || event.type === "tool.completed") &&
                event.payload.toolCallId === preparation.payload.toolCallId,
            );
            return {
              tool: preparation.payload.toolName,
              preparationMs: end
                ? Date.parse(end.occurredAt) - Date.parse(preparation.occurredAt)
                : null,
            };
          });
        progress(JSON.stringify({ spans }));
      }
      throw error;
    } finally {
      await settled;
    }
  });
}

async function waitForPreview(browser, sessionId) {
  const path = `/v1/conversations/${encodeURIComponent(sessionId)}/preview/4173/`;
  const deadline = Date.now() + 90_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const bootstrap = await browser.fetch(path, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    lastStatus = bootstrap.status;
    const location = bootstrap.headers.get("location");
    if (bootstrap.status === 307 && location !== null) {
      const publicUrl = new URL(location, baseUrl);
      const response = await readPreviewDocument(publicUrl, connectHost);
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { path: publicUrl.toString(), html: response.body.toString("utf8") };
      }
    }
    await wait(500);
  }
  throw new Error(`Snake preview did not become reachable; last HTTP status ${String(lastStatus)}`);
}

async function exerciseGame({ username, password, previewPath, screenshotPath }) {
  return withChromePage(
    {
      profilePrefix: "pi-cloud-snake-chrome-",
      width: 1_280,
      height: 900,
      additionalArguments: ["--host-resolver-rules=MAP *.preview.localhost 127.0.0.1"],
    },
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
      assert.equal(Number.isSafeInteger(before.tick), true, "Snake tick was not an integer");
      assert.equal(before.running, false, "Snake started before the Start button was pressed");
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
      assert.equal(Number.isSafeInteger(after.tick), true, "Snake tick stopped being an integer");
      assert(after.tick > before.tick, "Snake game loop did not advance after starting");
      assert(
        after.headX !== before.headX || after.headY !== before.headY,
        "Snake head did not move after starting the game",
      );
      await page.evaluate('document.querySelector("#pause-button").click()');
      const paused = await page.evaluate("window.__snakeTestState()");
      assert.equal(paused.running, false, "Pause button did not clear the running state");
      await page.wait(450);
      const pausedAfterWait = await page.evaluate("window.__snakeTestState()");
      assert.equal(pausedAfterWait.tick, paused.tick, "Pause button did not stop the game loop");
      assert.equal(pausedAfterWait.headX, paused.headX);
      assert.equal(pausedAfterWait.headY, paused.headY);
      await page.evaluate('document.querySelector("#reset-button").click()');
      const reset = await page.evaluate("window.__snakeTestState()");
      assert.equal(reset.score, 0, "Reset button did not reset the score");
      assert.equal(reset.running, false, "Reset button did not clear the running state");
      assert.equal(reset.tick, 0, "Reset button did not reset the game-loop tick");
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
let environmentReleased = reusedSessionId !== undefined;
let conversationDeleted = reusedSessionId !== undefined;
let screenshotDeleted = false;

async function cleanup(strict) {
  const failures = [];
  if (!environmentReleased && development !== undefined) {
    try {
      await api.developmentEnvironmentAction(
        development.environmentId,
        "release",
        newIdempotencyKey("release-environment"),
      );
      environmentReleased = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!conversationDeleted && session !== undefined) {
    try {
      await api.deleteConversation(session.sessionId, newIdempotencyKey("delete-conversation"));
      conversationDeleted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (!screenshotDeleted) {
    try {
      await rm(screenshotPath, { force: true });
      screenshotDeleted = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (strict && failures.length > 0) {
    throw new AggregateError(failures, "Snake acceptance cleanup failed");
  }
}

try {
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
      "development_environment",
      "standard",
      DEFAULT_EXCLUSIVE_WORKING_DIRECTORY,
      process.env.PI_CLOUD_SNAKE_MODEL_ID === undefined
        ? undefined
        : {
            provider: "openai-codex",
            modelId: process.env.PI_CLOUD_SNAKE_MODEL_ID,
            thinkingLevel: "off",
            fastMode: false,
          },
    );
    progress("asking the real model to build, test and serve Snake");
    coding = await runCodingWithPreparationBrowser(api, browser, session.sessionId);
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
      firstDurableActivityMs: null,
      firstToolStartedMs: null,
      firstAssistantTextMs: null,
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
  assert(serializedConversation.includes('"toolName":"preview"'));
  assert(!serializedConversation.includes("http://localhost:4173/"));
  if (reusedSessionId === undefined) {
    await cleanup(true);
    progress("released all acceptance-only resources");
  }
  const previewUrl = new URL(preview.path);
  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    workingTreeDirty,
    checkedAt: new Date().toISOString(),
    account: username,
    sessionId: session.sessionId,
    workspaceId: development.workspaceId,
    developmentEnvironmentId: development.environmentId,
    runId: coding.accepted.runId,
    toolCalls: coding.toolStarts,
    toolPreparations: coding.toolPreparations,
    preparationBrowser: coding.preparationBrowser,
    previewToolUsed: coding.previewToolUsed,
    firstDurableActivityMs: coding.firstDurableActivityMs,
    firstToolStartedMs: coding.firstToolStartedMs,
    firstAssistantTextMs: coding.firstAssistantTextMs,
    settledMs: coding.settledMs,
    hostPreviewStatus: 200,
    previewOrigin: previewUrl.origin,
    previewRoute: `/v1/conversations/${session.sessionId}/preview/4173`,
    browserInteraction: interaction,
    screenshotCaptured: true,
    conversationRetainedForInspection: reusedSessionId !== undefined,
    developmentEnvironmentReleased: environmentReleased,
    cleanupCompleted: environmentReleased && conversationDeleted && screenshotDeleted,
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
} finally {
  await cleanup(false);
}
