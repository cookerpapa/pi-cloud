import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseWorkspaceTerminalServerFrame } from "../packages/protocol/src/index.ts";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import WebSocket from "ws";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_PRODUCT_SURFACE_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_PRODUCT_SURFACE_CHECK=1 to acknowledge real model and Cube usage",
  );
}

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
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
const host =
  environment.PI_CLOUD_HTTP_BIND_ADDRESS === "0.0.0.0"
    ? "127.0.0.1"
    : environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (host === undefined || port === undefined) throw new Error("Production endpoint is missing");
const baseUrl = new URL(`http://${host}:${port}`);

async function psql(query) {
  const { stdout } = await exec(
    process.execPath,
    [
      "scripts/production-compose.mjs",
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "pi_cloud",
      "--dbname",
      "pi_cloud",
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      query,
    ],
    { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 2 * 1_024 * 1_024 },
  );
  return stdout.trim();
}

async function waitForWorkspacePurge(workspaceId) {
  assert.match(workspaceId, /^[0-9a-f-]{36}$/u);
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const purged = await psql(
      `select coalesce((select storage_purged_at is not null from workspaces where id = '${workspaceId}'), true)::text`,
    );
    if (purged === "true") return;
    await wait(250);
  }
  throw new Error(`Workspace ${workspaceId} storage was not purged`);
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
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
      if (match === null) continue;
      this.#cookie = match[1] === "pi_cloud_session=" ? undefined : match[1];
    }
    return response;
  };
}

function progress(stage) {
  process.stdout.write(`[product-surface-check] ${stage}\n`);
}

async function waitForRun(api, runId, expectedStates, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (expectedStates.includes(run.state)) return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ended as ${run.state}${run.failure === undefined ? "" : `: ${run.failure.code}`}`,
      );
    }
    await wait(100);
  }
  throw new Error("Run did not settle before its API acceptance deadline");
}

async function runTurn({
  api,
  browser,
  sessionId,
  prompt,
  expectTools,
  expectedTerminal = "turn.completed",
  onToolStarted,
}) {
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const acceptedAt = performance.now();
  const controller = new AbortController();
  const events = [];
  let terminal;
  let firstDurableActivityAt;
  let firstToolStartedAt;
  let firstAssistantTextAt;
  let intervention;
  const observeEvent = (event) => {
    if (events.some((candidate) => candidate.eventId === event.eventId)) return;
    events.push(event);
    if (event.turnId !== accepted.turnId) return;
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
    if (event.type === "tool.started" && intervention === undefined && onToolStarted) {
      intervention = Promise.resolve(onToolStarted(accepted));
    }
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      terminal = event;
      controller.abort();
    }
  };
  const timer = setTimeout(
    () => controller.abort(new Error("Product surface turn timed out")),
    180_000,
  );
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
    await intervention;
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, expectedTerminal, JSON.stringify(terminal.payload));
    assert(firstDurableActivityAt !== undefined, "Turn did not publish a durable Agent activity");
    if (expectedTerminal === "turn.completed") {
      assert(firstAssistantTextAt !== undefined, "Completed Turn did not stream assistant text");
    }
    const toolCalls = events.filter(
      (event) => event.turnId === accepted.turnId && event.type === "tool.started",
    ).length;
    assert.equal(toolCalls > 0, expectTools, "Turn Tool behavior did not match its contract");
    if (expectTools) assert(firstToolStartedAt !== undefined, "Coding turn had no Tool start");
    const expectedRunState = expectedTerminal === "turn.cancelled" ? "cancelled" : "completed";
    await waitForRun(api, accepted.runId, [expectedRunState]);
    return {
      accepted,
      events,
      acceptedMs: Math.round(acceptedAt - submittedAt),
      firstDurableActivityMs:
        firstDurableActivityAt === undefined
          ? undefined
          : Math.round(firstDurableActivityAt - submittedAt),
      firstToolStartedMs:
        firstToolStartedAt === undefined ? null : Math.round(firstToolStartedAt - submittedAt),
      firstAssistantTextMs:
        firstAssistantTextAt === undefined
          ? undefined
          : Math.round(firstAssistantTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function expectApiStatus(operation, status) {
  await assert.rejects(
    operation,
    (error) => error instanceof PiCloudApiError && error.status === status,
  );
}

async function openHeldTerminal(sessionId, cookieHeader) {
  const url = new URL(`/v1/conversations/${encodeURIComponent(sessionId)}/terminal`, baseUrl);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { cookie: cookieHeader } });
  let output = "";
  let ready = false;
  const terminal = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("Workspace terminal timed out")),
      90_000,
    );
    socket.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    socket.on("message", (value) => {
      try {
        const frame = parseWorkspaceTerminalServerFrame(JSON.parse(String(value)));
        if (frame.type === "workspace_terminal.error") {
          clearTimeout(timer);
          rejectPromise(new Error(`${frame.code}: ${frame.message}`));
          return;
        }
        if (frame.type === "workspace_terminal.ready") {
          ready = true;
          const command = Buffer.from("printf 'TERMINAL-SURFACE-OK\\n'", "utf8").toString("base64");
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.input",
              data: Buffer.from(
                `printf '%s' '${command}' | base64 -d | /bin/bash\n`,
                "utf8",
              ).toString("base64"),
            }),
          );
          return;
        }
        if (frame.type === "workspace_terminal.output") {
          output += Buffer.from(frame.data, "base64").toString("utf8");
          if (output.includes("TERMINAL-SURFACE-OK")) {
            clearTimeout(timer);
            resolvePromise();
          }
        }
      } catch (error) {
        clearTimeout(timer);
        rejectPromise(error);
      }
    });
  });
  await terminal;
  return {
    ready,
    output: () => output,
    close: async () => {
      const closed = new Promise((resolvePromise) => socket.once("close", resolvePromise));
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.close",
          }),
        );
        await Promise.race([closed, wait(5_000)]);
      }
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await Promise.race([closed, wait(1_000)]);
    },
  };
}

async function openTerminal(sessionId, cookieHeader) {
  const terminal = await openHeldTerminal(sessionId, cookieHeader);
  try {
    return { ready: terminal.ready, output: terminal.output() };
  } finally {
    await terminal.close();
  }
}

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const username = `surface-${suffix}`.slice(0, 48);
const password = `PiCloud acceptance ${suffix} 9!`;
const browser = new BrowserCookieFetch();
const api = new PiCloudApi(browser.fetch);
const createdSessionIds = new Set();
const createdWorkspaceIds = new Set();

try {
  progress("registering and authenticating through browser cookie APIs");
  const registration = await api.registerAccount(username, "Product Surface User", password);
  assert.equal(registration.identity.platformAdministrator, false);
  assert.equal((await api.getIdentity()).userId, registration.identity.userId);
  await api.logout();
  await expectApiStatus(api.getIdentity(), 401);
  const login = await api.loginAccount(username, password);
  assert.equal(login.identity.userId, registration.identity.userId);
  await expectApiStatus(api.getCubeProxyConfiguration(), 403);

  const project = await api.createProject(`Product surface ${suffix}`);
  createdWorkspaceIds.add(project.workspaceId);
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Product surface ${suffix}`,
    "elastic",
    "starter",
  );
  createdSessionIds.add(session.sessionId);
  assert(
    (await api.listWorkspaces()).workspaces.some(
      (item) => item.workspaceId === project.workspaceId,
    ),
  );
  assert(
    (await api.listConversations()).conversations.some(
      (item) => item.sessionId === session.sessionId,
    ),
  );
  progress("workspace and conversation creation passed");

  const chat = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-CHAT-OK.",
    expectTools: false,
  });
  const fullTree = await api.getConversationTree(session.sessionId, "full");
  const focusTree = await api.getConversationTree(session.sessionId, "focus");
  assert.equal(fullTree.currentSessionId, session.sessionId);
  assert.equal(focusTree.branches.length, 1);
  const parentBranch = fullTree.branches.find((branch) => branch.sessionId === session.sessionId);
  assert(parentBranch);
  const forkEntry = parentBranch.entries.find(
    (entry) => entry.turnId === chat.accepted.turnId && entry.finalAssistant,
  );
  assert(forkEntry, "Settled assistant entry was absent from the conversation tree");
  progress("pure chat, resumable SSE and tree projection passed");

  const fork = await api.forkConversation(
    session.sessionId,
    chat.accepted.turnId,
    forkEntry.entryId,
    `Product surface fork ${suffix}`,
    newIdempotencyKey("fork"),
  );
  createdSessionIds.add(fork.session.sessionId);
  const treeWithFork = await api.getConversationTree(fork.session.sessionId, "full");
  assert(treeWithFork.branches.some((branch) => branch.sessionId === session.sessionId));
  assert(treeWithFork.branches.some((branch) => branch.sessionId === fork.session.sessionId));
  await api.deleteConversation(fork.session.sessionId, newIdempotencyKey("delete"));
  assert(
    !(await api.listConversations()).conversations.some(
      (item) => item.sessionId === fork.session.sessionId,
    ),
  );
  progress("conversation fork and recursive branch deletion passed");

  const later = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-LATER-OK.",
    expectTools: false,
  });
  const prune = await api.pruneConversation(
    session.sessionId,
    chat.accepted.turnId,
    forkEntry.entryId,
    newIdempotencyKey("prune"),
  );
  assert(prune.prunedTurnCount >= 1);
  assert.equal((await api.getConversation(session.sessionId)).turns.length, 1);
  progress("settled-message tail pruning passed");

  const coding = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt: [
      "Use tools in the current Workspace.",
      "Create surface_check.py containing a function add(a, b) and executable assertions for positive, negative and zero values.",
      "Run python3 surface_check.py and make it print exactly PRODUCT-SURFACE-CODE-OK.",
    ].join(" "),
    expectTools: true,
  });
  const directory = await api.listWorkspaceDirectory(session.sessionId);
  assert.equal(directory.workspaceId, project.workspaceId);
  assert(directory.entries.some((entry) => entry.path === "surface_check.py"));
  const source = await api.readWorkspaceFile(session.sessionId, "surface_check.py");
  assert(Buffer.from(source.bytes).toString("utf8").includes("def add"));
  progress("real coding, Tool execution and Workspace source browsing passed");

  const terminal = await openTerminal(session.sessionId, browser.cookieHeader);
  assert.equal(terminal.ready, true);
  assert(terminal.output.includes("TERMINAL-SURFACE-OK"));
  progress("authenticated Workspace terminal passed");

  const heldTerminal = await openHeldTerminal(session.sessionId, browser.cookieHeader);
  try {
    await runTurn({
      api,
      browser,
      sessionId: session.sessionId,
      prompt: [
        "Use tools while the human Workspace terminal remains connected.",
        "Create terminal_concurrency.txt containing exactly TERMINAL-AGENT-CONCURRENCY-OK.",
        "Read it back, then reply exactly TERMINAL-AGENT-CONCURRENCY-OK.",
      ].join(" "),
      expectTools: true,
    });
  } finally {
    await heldTerminal.close();
  }
  progress("Workspace terminal and Agent concurrency passed");

  const siblingSession = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Product surface sibling ${suffix}`,
    "elastic",
    "starter",
  );
  createdSessionIds.add(siblingSession.sessionId);
  const concurrentRuns = await Promise.all([
    runTurn({
      api,
      browser,
      sessionId: session.sessionId,
      prompt:
        "Use bash exactly once. In that command sleep 3, create concurrent_session_a.txt containing exactly SESSION-A-OK, and read it back. Then reply exactly SESSION-A-OK.",
      expectTools: true,
    }),
    runTurn({
      api,
      browser,
      sessionId: siblingSession.sessionId,
      prompt:
        "Use bash exactly once. In that command sleep 3, create concurrent_session_b.txt containing exactly SESSION-B-OK, and read it back. Then reply exactly SESSION-B-OK.",
      expectTools: true,
    }),
  ]);
  assert(concurrentRuns.every((run) => run.events.some((event) => event.type === "tool.started")));
  const concurrentRuntimeEvidence = await psql(
    `select count(distinct workspace_runtime_id)::text || '|' ||
            count(distinct tool_binding_id)::text || '|' ||
            exists (
              select 1
                from tool_broker_operations left_operation
                join tool_broker_operations right_operation
                  on left_operation.run_id <> right_operation.run_id
                 and left_operation.started_at < right_operation.settled_at
                 and right_operation.started_at < left_operation.settled_at
               where left_operation.run_id in ('${concurrentRuns[0].accepted.runId}', '${concurrentRuns[1].accepted.runId}')
                 and right_operation.run_id in ('${concurrentRuns[0].accepted.runId}', '${concurrentRuns[1].accepted.runId}')
            )::text
       from tool_broker_operations
      where run_id in ('${concurrentRuns[0].accepted.runId}', '${concurrentRuns[1].accepted.runId}')`,
  );
  assert.equal(concurrentRuntimeEvidence, "1|2|true");
  progress("two Sessions sharing one Workspace ran concurrently");

  let steerAccepted = false;
  const steered = await runTurn({
    api,
    browser,
    sessionId: session.sessionId,
    prompt:
      "Use bash exactly once to run sleep 8. After it finishes, reply exactly OLD-STEER-TEXT.",
    expectTools: true,
    onToolStarted: async (accepted) => {
      const result = await api.steerTurn(
        session.sessionId,
        accepted.turnId,
        "Replace the requested final reply with exactly PRODUCT-SURFACE-STEER-OK.",
        newIdempotencyKey("steer"),
      );
      steerAccepted = result.state === "delivered";
    },
  });
  assert.equal(steerAccepted, true);
  const afterSteer = await api.getConversation(session.sessionId);
  assert(JSON.stringify(afterSteer).includes("PRODUCT-SURFACE-STEER-OK"));
  progress("active Turn steer passed");

  let cancelAccepted = false;
  const cancelled = await runTurn({
    api,
    browser,
    sessionId: siblingSession.sessionId,
    prompt: "Use bash exactly once to run sleep 60, then report completion.",
    expectTools: true,
    expectedTerminal: "turn.cancelled",
    onToolStarted: async (accepted) => {
      await api.cancelTurn(session.sessionId, accepted.turnId, newIdempotencyKey("cancel"), 250);
      cancelAccepted = true;
    },
  });
  assert.equal(cancelAccepted, true);
  const recovery = await runTurn({
    api,
    browser,
    sessionId: siblingSession.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-RECOVERY-OK.",
    expectTools: false,
  });
  progress("cancellation and next-Turn interruption recovery passed");

  const detachableProject = await api.createProject(`Rebind surface ${suffix}`);
  createdWorkspaceIds.add(detachableProject.workspaceId);
  const sibling = await api.createSession(
    detachableProject.projectId,
    detachableProject.workspaceId,
    `Rebind surface ${suffix}`,
    "elastic",
  );
  createdSessionIds.add(sibling.sessionId);
  await runTurn({
    api,
    browser,
    sessionId: sibling.sessionId,
    prompt: "Do not call tools. Reply with exactly PRODUCT-SURFACE-PRE-REBIND-OK.",
    expectTools: false,
  });
  progress("secondary conversation baseline passed");

  const foreignBrowser = new BrowserCookieFetch();
  const foreignApi = new PiCloudApi(foreignBrowser.fetch);
  await foreignApi.registerAccount(
    `foreign-${suffix}`.slice(0, 48),
    "Foreign Surface User",
    `${password} foreign`,
  );
  await expectApiStatus(foreignApi.getConversation(session.sessionId), 404);
  assert(
    !(await foreignApi.listWorkspaces()).workspaces.some(
      (workspace) => workspace.workspaceId === project.workspaceId,
    ),
  );
  progress("cross-tenant API isolation passed");

  const workspaceDeletion = await api.deleteWorkspace(
    detachableProject.workspaceId,
    newIdempotencyKey("delete"),
  );
  assert.equal(workspaceDeletion.workspaceId, detachableProject.workspaceId);
  assert.equal(workspaceDeletion.detachedSessionCount, 1);
  assert.equal((await api.getConversation(sibling.sessionId)).session.workspaceState, "missing");
  const rebindProject = await api.createProject(`Rebound surface ${suffix}`);
  createdWorkspaceIds.add(rebindProject.workspaceId);
  const rebound = await api.rebindConversationWorkspace(
    sibling.sessionId,
    rebindProject.workspaceId,
    newIdempotencyKey("workspace-rebind"),
  );
  assert.equal(rebound.workspaceState, "attached");
  const reboundTurn = await runTurn({
    api,
    browser,
    sessionId: sibling.sessionId,
    prompt:
      "Do not call tools. If the hidden Harness context says this Session is attached to a different workspace, reply exactly PRODUCT-SURFACE-WORKSPACE-CHANGE-SEEN. Otherwise reply exactly PRODUCT-SURFACE-WORKSPACE-CHANGE-MISSING.",
    expectTools: false,
  });
  assert.match(
    reboundTurn.events
      .filter((event) => event.type === "assistant.text.delta")
      .map((event) => event.payload.text)
      .join(""),
    /PRODUCT-SURFACE-WORKSPACE-CHANGE-SEEN/,
  );
  await api.deleteConversation(sibling.sessionId, newIdempotencyKey("delete"));
  await api.deleteConversation(session.sessionId, newIdempotencyKey("delete"));
  const deletion = await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  assert.equal(deletion.workspaceId, project.workspaceId);
  await waitForWorkspacePurge(project.workspaceId);
  assert(
    !(await api.listWorkspaces()).workspaces.some(
      (workspace) => workspace.workspaceId === project.workspaceId,
    ),
  );
  progress("conversation preservation, Workspace rebind, and deletion passed");

  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    checkedAt: new Date().toISOString(),
    browserCookieAuth: true,
    latencyMs: {
      pureChat: {
        accepted: chat.acceptedMs,
        firstDurableActivity: chat.firstDurableActivityMs,
        firstToolStarted: chat.firstToolStartedMs,
        firstAssistantText: chat.firstAssistantTextMs,
        settled: chat.settledMs,
      },
      coding: {
        accepted: coding.acceptedMs,
        firstDurableActivity: coding.firstDurableActivityMs,
        firstToolStarted: coding.firstToolStartedMs,
        firstAssistantText: coding.firstAssistantTextMs,
        settled: coding.settledMs,
      },
    },
    treeForkPrune: true,
    workspaceBrowserEntries: directory.entries.length,
    terminal: true,
    terminalAgentConcurrency: true,
    sharedWorkspaceConcurrentSessions: true,
    sharedWorkspaceConcurrentToolBindings: true,
    steer: true,
    cancelAndRecover: true,
    workspaceRebind: true,
    tenantIsolation: true,
    deletion: "purged",
  };
  await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
  await writeFile(
    resolve(repositoryRoot, "docs/reports/product-surface-acceptance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  for (const sessionId of createdSessionIds) {
    await api.deleteConversation(sessionId, newIdempotencyKey("delete")).catch(() => undefined);
  }
  for (const workspaceId of createdWorkspaceIds) {
    await api.deleteWorkspace(workspaceId, newIdempotencyKey("delete")).catch(() => undefined);
    await waitForWorkspacePurge(workspaceId).catch(() => undefined);
  }
}
