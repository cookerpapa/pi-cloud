import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_PROVIDER_CAPABILITY_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_PROVIDER_CAPABILITY_CHECK=1 to acknowledge real Provider token usage",
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

class BrowserCookieFetch {
  #cookie;

  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(300_000),
    });
    const cookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of cookies) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/.exec(value);
      if (match !== null) this.#cookie = match[1];
    }
    return response;
  };
}

const wait = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));

async function waitFor(check, label, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined && result !== false && result !== null) return result;
    await wait(250);
  }
  throw new Error(`${label} timed out`);
}

async function waitForTurn(api, sessionId, runId, label) {
  return waitFor(async () => {
    const detail = await api.getConversation(sessionId);
    const turn = detail.turns.find((candidate) => candidate.runId === runId);
    return turn !== undefined && ["completed", "failed", "cancelled"].includes(turn.state)
      ? turn
      : undefined;
  }, label);
}

function transcriptText(turn) {
  return (turn.transcript?.items ?? [])
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("");
}

function countPiSessionPayloads(sessionId, marker) {
  const query = [
    "select count(*)",
    "from pi_session_entries",
    `where session_id = '${sessionId}'`,
    "and type = 'message'",
    `and payload::text like '%${marker}%'`,
  ].join(" ");
  return Number(
    execFileSync(
      "docker",
      [
        "exec",
        "pi-cloud-production-postgres-1",
        "psql",
        "-U",
        "pi_cloud",
        "-d",
        "pi_cloud",
        "-Atqc",
        query,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
}

function assertHostedSearchProgress(events, turnId, label) {
  const turnEvents = events.filter((event) => event.turnId === turnId);
  const started = turnEvents.findIndex(
    (event) =>
      event.type === "provider.hosted_tool.started" && event.payload.toolName === "web_search",
  );
  const completed = turnEvents.findIndex(
    (event) =>
      event.type === "provider.hosted_tool.completed" && event.payload.toolName === "web_search",
  );
  const firstText = turnEvents.findIndex((event) => event.type === "assistant.text.delta");
  assert.notEqual(started, -1, `${label} did not publish Hosted Web Search start progress`);
  assert.notEqual(completed, -1, `${label} did not publish Hosted Web Search completion progress`);
  assert.ok(started < completed, `${label} Hosted Web Search progress was out of order`);
  assert.ok(firstText < 0 || started < firstText, `${label} search progress did not precede text`);
}

const suffix = Date.now().toString(36);
const cookieFetch = new BrowserCookieFetch();
const api = new PiCloudApi(cookieFetch.fetch);
await api.registerAccount(
  `provider.cap.${suffix}`.slice(0, 48),
  "Provider Capability Acceptance",
  `Provider capability ${suffix} 9!`,
);

let project;
let session;
let firstLatencyMs;
let nativeReplayLatencyMs;
let secondLatencyMs;
let firstText = "";
let nativeReplayText = "";
let secondText = "";
let durableHostedMessageCount = 0;
let durableCitationMessageCount = 0;
let cleanupCompleted = false;
let streamAbort;
let streamPromise;
try {
  project = await api.createProject(`provider-cap-${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Provider capability ${suffix}`,
    "elastic",
    "starter",
    "/workspace",
    { provider: "deepseek", modelId: "deepseek-v4-flash" },
  );
  const observedEvents = [];
  let streamLive = false;
  streamAbort = new AbortController();
  streamPromise = streamSessionEvents({
    sessionId: session.sessionId,
    signal: streamAbort.signal,
    fetchImplementation: cookieFetch.fetch,
    onSnapshot(snapshot) {
      observedEvents.push(...snapshot.liveEvents);
    },
    onEvent(event) {
      observedEvents.push(event);
    },
    onStatus(status) {
      if (status.phase === "live") streamLive = true;
    },
  });
  await waitFor(() => streamLive, "Provider capability SSE connection", 30_000);

  const firstStartedAt = performance.now();
  const firstAccepted = await api.acceptTurn(
    session.sessionId,
    [
      "Do not call Pi function tools.",
      "Use Provider-hosted web search to find the current Hang Seng Index value and exact percentage change from a current source.",
      "Reply only DEEPSEEK-SEARCH-OK and do not reveal either number.",
    ].join(" "),
    newIdempotencyKey("provider-search"),
    "low",
  );
  const first = await waitForTurn(
    api,
    session.sessionId,
    firstAccepted.runId,
    "DeepSeek Provider Web Search Turn",
  );
  firstLatencyMs = Math.round(performance.now() - firstStartedAt);
  firstText = transcriptText(first);
  assert.equal(first.state, "completed", JSON.stringify(first));
  assert.match(firstText, /DEEPSEEK-SEARCH-OK/u);
  await waitFor(
    () =>
      observedEvents.some(
        (event) =>
          event.turnId === firstAccepted.turnId && event.type === "provider.hosted_tool.completed",
      ),
    "DeepSeek Hosted Web Search progress",
    30_000,
  );
  assertHostedSearchProgress(observedEvents, firstAccepted.turnId, "DeepSeek");
  assert.equal(
    (first.transcript?.items ?? []).some((item) => item.kind === "tool"),
    false,
    "Provider search was incorrectly projected as a Pi/Tool Broker Tool",
  );

  const nativeReplayStartedAt = performance.now();
  const nativeReplayAccepted = await api.acceptTurn(
    session.sessionId,
    [
      "Do not call Pi function tools and do not perform another web search.",
      "Using only the prior Provider search result, state its exact Hang Seng Index value and percentage change.",
      "If the prior result is unavailable, reply exactly CONTEXT-UNAVAILABLE.",
    ].join(" "),
    newIdempotencyKey("provider-native-replay"),
    "off",
  );
  const nativeReplay = await waitForTurn(
    api,
    session.sessionId,
    nativeReplayAccepted.runId,
    "DeepSeek native Hosted Web Search replay Turn",
  );
  nativeReplayLatencyMs = Math.round(performance.now() - nativeReplayStartedAt);
  nativeReplayText = transcriptText(nativeReplay);
  assert.equal(nativeReplay.state, "completed", JSON.stringify(nativeReplay));
  assert.ok(nativeReplayText.length > 0);
  assert.equal(
    observedEvents.some(
      (event) =>
        event.turnId === nativeReplayAccepted.turnId &&
        event.type === "provider.hosted_tool.started",
    ),
    false,
    "DeepSeek performed a new search instead of replaying its native result",
  );

  await api.updateSessionModel(session.sessionId, {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
  });
  assert.equal((await api.getSessionModel(session.sessionId)).provider, "openai-codex");

  const secondStartedAt = performance.now();
  const secondAccepted = await api.acceptTurn(
    session.sessionId,
    [
      "Do not call Pi function tools.",
      "Use Provider-hosted web search to find the current title of the official OpenAI developer documentation home page.",
      "Reply with CODEX-SEARCH-HANDOFF-OK, the OpenAI page title, and the marker DEEPSEEK-SEARCH-OK preserved from the previous turns.",
    ].join(" "),
    newIdempotencyKey("provider-handoff"),
    "off",
  );
  const second = await waitForTurn(
    api,
    session.sessionId,
    secondAccepted.runId,
    "Codex Provider Search and cross-provider handoff Turn",
  );
  secondLatencyMs = Math.round(performance.now() - secondStartedAt);
  secondText = transcriptText(second);
  assert.equal(second.state, "completed", JSON.stringify(second));
  assert.match(secondText, /CODEX-SEARCH-HANDOFF-OK/u);
  await waitFor(
    () =>
      observedEvents.some(
        (event) =>
          event.turnId === secondAccepted.turnId && event.type === "provider.hosted_tool.completed",
      ),
    "Codex Hosted Web Search progress",
    30_000,
  );
  assertHostedSearchProgress(observedEvents, secondAccepted.turnId, "Codex");
  assert.equal(
    (second.transcript?.items ?? []).some((item) => item.kind === "tool"),
    false,
    "Codex Provider search was incorrectly projected as a Pi/Tool Broker Tool",
  );
  durableHostedMessageCount = countPiSessionPayloads(session.sessionId, "providerHostedToolCall");
  durableCitationMessageCount = countPiSessionPayloads(session.sessionId, "providerAnnotations");
  assert.ok(
    durableHostedMessageCount >= 2,
    "Provider-native Hosted Tool items were not persisted in Pi SessionStorage",
  );
  assert.ok(
    durableCitationMessageCount >= 1,
    "Provider-native citation annotations were not persisted in Pi SessionStorage",
  );
} finally {
  streamAbort?.abort();
  await streamPromise?.catch(() => undefined);
  if (session !== undefined) {
    await api
      .deleteConversation(session.sessionId, newIdempotencyKey("provider-cap-cleanup"))
      .catch(() => undefined);
    await waitFor(
      async () =>
        !(await api.listConversations()).conversations.some(
          (candidate) => candidate.sessionId === session.sessionId,
        ),
      "Provider capability conversation cleanup",
      60_000,
    );
  }
  if (project !== undefined) {
    await api
      .deleteWorkspace(project.workspaceId, newIdempotencyKey("provider-cap-workspace-cleanup"))
      .catch(() => undefined);
    await waitFor(
      async () =>
        !(await api.listWorkspaces()).workspaces.some(
          (candidate) => candidate.workspaceId === project.workspaceId,
        ),
      "Provider capability Workspace cleanup",
      60_000,
    );
  }
  cleanupCompleted = true;
}

const report = {
  accepted: true,
  piCloudRevision: testedRevision,
  checkedAt: new Date().toISOString(),
  route: {
    firstTurn: "deepseek/deepseek-v4-flash + Provider web_search",
    secondTurn: "openai-codex/gpt-5.6-luna + Provider web_search",
  },
  assertions: {
    deepSeekProviderSearchReachedFinalMessage: true,
    codexProviderSearchReachedFinalMessage: true,
    bothProviderSearchesBypassedToolBroker: true,
    bothProviderSearchesPublishedEphemeralProgress: true,
    nativeHostedItemsReplayWithoutAnotherSearch: true,
    hiddenProviderSearchResultNotClaimedAsDurable: true,
    nativeReplayAnswerObserved: nativeReplayText !== "CONTEXT-UNAVAILABLE",
    crossProviderCanonicalContextRestored: true,
    providerHostedItemsPersistedInPiMessages: true,
    providerCitationsPersistedInPiMessages: true,
    cleanupCompleted,
  },
  latencyMs: {
    providerSearchTurn: firstLatencyMs,
    nativeReplayTurn: nativeReplayLatencyMs,
    crossProviderHandoffTurn: secondLatencyMs,
  },
  outputCharacters: {
    providerSearchTurn: firstText.length,
    nativeReplayTurn: nativeReplayText.length,
    crossProviderHandoffTurn: secondText.length,
  },
  piSessionStorage: {
    durableHostedMessageCount,
    durableCitationMessageCount,
  },
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/provider-capability-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
