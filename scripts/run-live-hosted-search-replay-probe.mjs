import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_CLOUD_LIVE_HOSTED_SEARCH_REPLAY_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_HOSTED_SEARCH_REPLAY_CHECK=1 to acknowledge real Provider token usage",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const apiKey = (
  await readFile(resolve(runtimeDirectory, "secrets/cli-proxy-api-key"), "utf8")
).trim();
const providerGatewayUrl =
  process.env.PI_CLOUD_PROVIDER_GATEWAY_PROBE_URL ??
  `http://${execFileSync(
    "docker",
    [
      "inspect",
      "pi-cloud-production-cli-proxy-api-1",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    ],
    { encoding: "utf8" },
  ).trim()}:8317`;

const routes = {
  gpt: "gpt-5.6-luna",
  deepseek: "deepseek-v4-flash",
};

async function response(model, input, suffix, tools = []) {
  const result = await fetch(`${providerGatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "session-id": `pi-cloud-hosted-replay-${suffix}-${Date.now().toString(36)}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      store: false,
      instructions: "Follow the request exactly. Do not guess unavailable facts.",
      input,
      tools,
      ...(tools.length === 0 ? {} : { tool_choice: "auto" }),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await result.text();
  if (!result.ok) {
    const error = new Error(`Provider replay request failed with HTTP ${String(result.status)}`);
    error.status = result.status;
    throw error;
  }
  return JSON.parse(body);
}

function outputText(result) {
  return (result.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text)
    .join("");
}

function hasSearch(result) {
  return (result.output ?? []).some((item) => item.type === "web_search_call");
}

function nativeSearchResultPayloadPresent(items) {
  const resultKeys = new Set(["sources", "results", "snippet", "text", "content"]);
  return items
    .filter((item) => item.type === "web_search_call")
    .some((item) => Object.keys(item.action ?? {}).some((key) => resultKeys.has(key)));
}

const seedPrompt = [
  {
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Use web search to find the current Hang Seng Index value and exact percentage change from a current source.",
          "Reply only SEARCH-COMPLETE and do not reveal either number.",
        ].join(" "),
      },
    ],
  },
];
const followUp = {
  role: "user",
  content: [
    {
      type: "input_text",
      text: [
        "Without performing another search, state the exact index value and percentage change returned by the previous search.",
        "If that result is unavailable, reply exactly CONTEXT-UNAVAILABLE.",
      ].join(" "),
    },
  ],
};

const seeds = {};
const seedEvidence = {};
for (const [name, model] of Object.entries(routes)) {
  const result = await response(model, seedPrompt, `${name}-seed`, [{ type: "web_search" }]);
  assert.equal(result.status, "completed", `${name} seed response did not complete`);
  assert.equal(hasSearch(result), true, `${name} seed response did not use Hosted Web Search`);
  seeds[name] = result.output;
  seedEvidence[name] = {
    searchCallCount: result.output.filter((item) => item.type === "web_search_call").length,
    nativeSearchResultPayloadPresent: nativeSearchResultPayloadPresent(result.output),
  };
}
assert.equal(seedEvidence.gpt.nativeSearchResultPayloadPresent, false);
assert.equal(seedEvidence.deepseek.nativeSearchResultPayloadPresent, false);

const matrix = {};
for (const [source, items] of Object.entries(seeds)) {
  for (const [target, model] of Object.entries(routes)) {
    const key = `${source}To${target[0].toUpperCase()}${target.slice(1)}`;
    try {
      const result = await response(
        model,
        [...items.filter((item) => item.type === "web_search_call"), followUp],
        key,
      );
      const text = outputText(result).trim();
      matrix[key] = {
        accepted: true,
        followUpReturnedSpecificAnswer: text !== "CONTEXT-UNAVAILABLE",
      };
    } catch (error) {
      matrix[key] = {
        accepted: false,
        followUpReturnedSpecificAnswer: false,
        httpStatus:
          typeof error === "object" && error !== null && "status" in error
            ? error.status
            : undefined,
      };
    }
  }
}

assert.equal(matrix.gptToGpt.accepted, true);
assert.equal(matrix.deepseekToDeepseek.accepted, true);

const report = {
  checkedAt: new Date().toISOString(),
  piCloudRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
  seedRoutes: routes,
  seedEvidence,
  matrix,
  decision: {
    preserveNativeHostedItems: true,
    replayScope: "exact-provider-api-model",
    crossProviderContext: "assistant-text-and-citations-only",
    hiddenProviderSearchResultDurable: false,
    localToolCallSynthesis: false,
  },
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/hosted-search-native-replay-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
