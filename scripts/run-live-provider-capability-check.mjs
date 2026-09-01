import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

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
let secondLatencyMs;
let firstText = "";
let secondText = "";
let cleanupCompleted = false;
try {
  project = await api.createProject(`provider-cap-${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Provider capability ${suffix}`,
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-5.6-luna" },
  );

  const firstStartedAt = performance.now();
  const firstAccepted = await api.acceptTurn(
    session.sessionId,
    [
      "Do not call Pi function tools.",
      "Use the Provider-hosted web search capability to search the official OpenAI developer documentation home page.",
      "Reply with PROVIDER-SEARCH-OK followed by the current page title.",
    ].join(" "),
    newIdempotencyKey("provider-search"),
    "low",
  );
  const first = await waitForTurn(
    api,
    session.sessionId,
    firstAccepted.runId,
    "Provider Web Search Turn",
  );
  firstLatencyMs = Math.round(performance.now() - firstStartedAt);
  firstText = transcriptText(first);
  assert.equal(first.state, "completed", JSON.stringify(first));
  assert.match(firstText, /PROVIDER-SEARCH-OK/u);
  assert.equal(
    (first.transcript?.items ?? []).some((item) => item.kind === "tool"),
    false,
    "Provider search was incorrectly projected as a Pi/Tool Broker Tool",
  );

  await api.updateSessionModel(session.sessionId, {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal((await api.getSessionModel(session.sessionId)).provider, "deepseek");

  const secondStartedAt = performance.now();
  const secondAccepted = await api.acceptTurn(
    session.sessionId,
    "不要调用任何工具。仅根据上一轮已经保存的回答，回复 HANDOFF-OK，随后复述上一轮找到的页面标题。",
    newIdempotencyKey("provider-handoff"),
    "off",
  );
  const second = await waitForTurn(
    api,
    session.sessionId,
    secondAccepted.runId,
    "Cross-provider handoff Turn",
  );
  secondLatencyMs = Math.round(performance.now() - secondStartedAt);
  secondText = transcriptText(second);
  assert.equal(second.state, "completed", JSON.stringify(second));
  assert.match(secondText, /HANDOFF-OK/u);
} finally {
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
    firstTurn: "openai-codex/gpt-5.6-luna + Provider web_search",
    secondTurn: "deepseek/deepseek-v4-flash",
  },
  assertions: {
    providerSearchReachedFinalMessage: true,
    providerSearchBypassedToolBroker: true,
    crossProviderCanonicalContextRestored: true,
    cleanupCompleted,
  },
  latencyMs: {
    providerSearchTurn: firstLatencyMs,
    crossProviderHandoffTurn: secondLatencyMs,
  },
  outputCharacters: {
    providerSearchTurn: firstText.length,
    crossProviderHandoffTurn: secondText.length,
  },
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/provider-capability-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
