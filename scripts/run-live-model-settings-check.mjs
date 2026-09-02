import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_MODEL_SETTINGS_CHECK !== "1") {
  throw new Error("Set PI_CLOUD_LIVE_MODEL_SETTINGS_CHECK=1 to acknowledge real token usage");
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = Object.fromEntries(
  (await readFile(resolve(runtimeDirectory, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const host = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`);
const token = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
const api = new PiCloudApi(
  (input, init) =>
    fetch(new URL(String(input), baseUrl), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(300_000),
    }),
  token,
);
const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(check, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined && result !== false && result !== null) return result;
    await wait(250);
  }
  throw new Error(`${label} timed out`);
}

async function waitForTurn(sessionId, runId, label) {
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

function turnSnapshot(turnId) {
  const query = [
    "select provider, model_id, thinking_level, coalesce(service_tier, 'standard')",
    "from turns",
    `where id = '${turnId}'`,
  ].join(" ");
  const [provider, modelId, thinkingLevel, serviceTier] = execFileSync(
    "docker",
    [
      "exec",
      "pi-cloud-production-postgres-1",
      "psql",
      "-U",
      "pi_cloud",
      "-d",
      "pi_cloud",
      "-AtF",
      "\t",
      "-c",
      query,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\t");
  return { provider, modelId, thinkingLevel, serviceTier };
}

const suffix = Date.now().toString(36);
let project;
let session;
let fastLatencyMs;
let deepSeekLatencyMs;
let activeUpdateRejected = false;
try {
  project = await api.createProject(`model-settings-${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Model settings ${suffix}`,
    "elastic",
    "starter",
    "/workspace",
    {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      thinkingLevel: "medium",
      fastMode: true,
    },
  );
  assert.deepEqual(await api.getSessionModel(session.sessionId), {
    sessionId: session.sessionId,
    modelProfileId: session.modelProfileId,
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    thinkingLevel: "medium",
    fastMode: true,
  });

  const fastStartedAt = performance.now();
  const fastAccepted = await api.acceptTurn(
    session.sessionId,
    "Do not call tools. Reply exactly FAST-MODE-OK.",
    newIdempotencyKey("fast-mode"),
  );
  try {
    await api.updateSessionModel(session.sessionId, {
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      fastMode: false,
    });
  } catch (error) {
    activeUpdateRejected = error instanceof PiCloudApiError && error.code === "conflict";
  }
  assert.equal(activeUpdateRejected, true, "Active Turn accepted a model-settings mutation");
  const fastTurn = await waitForTurn(session.sessionId, fastAccepted.runId, "GPT Fast Turn");
  fastLatencyMs = Math.round(performance.now() - fastStartedAt);
  assert.equal(fastTurn.state, "completed", JSON.stringify(fastTurn));
  assert.match(transcriptText(fastTurn), /FAST-MODE-OK/u);
  assert.deepEqual(turnSnapshot(fastAccepted.turnId), {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
    thinkingLevel: "medium",
    serviceTier: "fast",
  });

  const deepSeekSettings = await api.updateSessionModel(session.sessionId, {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "high",
    fastMode: false,
  });
  assert.deepEqual(
    {
      provider: deepSeekSettings.provider,
      modelId: deepSeekSettings.modelId,
      thinkingLevel: deepSeekSettings.thinkingLevel,
      fastMode: deepSeekSettings.fastMode,
    },
    {
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      fastMode: false,
    },
  );
  const deepSeekStartedAt = performance.now();
  const deepSeekAccepted = await api.acceptTurn(
    session.sessionId,
    "Do not call tools. Reply exactly DEEPSEEK-HIGH-OK.",
    newIdempotencyKey("deepseek-high"),
  );
  const deepSeekTurn = await waitForTurn(
    session.sessionId,
    deepSeekAccepted.runId,
    "DeepSeek High Turn",
  );
  deepSeekLatencyMs = Math.round(performance.now() - deepSeekStartedAt);
  assert.equal(deepSeekTurn.state, "completed", JSON.stringify(deepSeekTurn));
  assert.match(transcriptText(deepSeekTurn), /DEEPSEEK-HIGH-OK/u);
  assert.deepEqual(turnSnapshot(deepSeekAccepted.turnId), {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "high",
    serviceTier: "standard",
  });
} finally {
  if (session !== undefined) {
    await api
      .deleteConversation(session.sessionId, newIdempotencyKey("model-settings-conversation"))
      .catch(() => undefined);
  }
  if (project !== undefined) {
    await api
      .deleteWorkspace(project.workspaceId, newIdempotencyKey("model-settings-workspace"))
      .catch(() => undefined);
    await waitFor(
      async () =>
        !(await api.listWorkspaces()).workspaces.some(
          (workspace) => workspace.workspaceId === project.workspaceId,
        ),
      "Model settings Workspace cleanup",
      60_000,
    );
  }
}

const report = {
  accepted: true,
  piCloudRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
  checkedAt: new Date().toISOString(),
  assertions: {
    gptFastRequestCompleted: true,
    activeTurnSettingsMutationRejected: activeUpdateRejected,
    gptFastTurnSnapshotPersisted: true,
    deepSeekHighTurnSnapshotPersistedWithoutFast: true,
    crossProviderSessionContinued: true,
    cleanupCompleted: true,
  },
  latencyMs: { gptFastTurn: fastLatencyMs, deepSeekHighTurn: deepSeekLatencyMs },
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/model-settings-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
