// Native Pi serialization contract against the Go adapter's local fake upstream.
// No real credentials, provider calls or user history are used.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { CloudModelRegistry } from "../../packages/sandbox-supervisor/src/durable/model-registry.ts";
const [endpoint, historyFile, mode] = process.argv.slice(2);
const key = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url");
const model = {
  id: "test-model",
  name: "fixture",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: endpoint,
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1000000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image = {
  type: "image",
  mimeType: "image/png",
  data: Buffer.alloc(128 * 1024, 37).toString("base64"),
};
const messages =
  mode === "first"
    ? [{ role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 1 }]
    : JSON.parse(await readFile(historyFile, "utf8"));
const options = {
  apiKey: `e30.${key}.fixture`,
  transport: "sse",
  sessionId: "stable-fixture",
  headers: { "X-PiCloud-Model-Session": "e".repeat(64) },
  maxRetries: 0,
  timeoutMs: 10000,
};
const registry = new CloudModelRegistry();
const nativeModel = registry.configure({
  ...model,
  modelId: model.id,
  apiKey: options.apiKey,
  inputModalities: model.input,
});
async function sample() {
  const result = await registry.models
    .streamSimple(
      nativeModel,
      {
        systemPrompt: "fixture",
        messages,
        tools: [
          {
            name: "read",
            description: "Read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      options,
    )
    .result();
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  messages.push(result);
  return result;
}
if (mode === "first") {
  const first = await sample();
  const call = first.content.find((c) => c.type === "toolCall");
  assert(call, "native Tool missing");
  messages.push({
    role: "toolResult",
    toolName: "read",
    toolCallId: call.id,
    content: [{ type: "text", text: "image" }, image],
    isError: false,
    timestamp: 2,
  });
  await sample();
  await writeFile(historyFile, JSON.stringify(messages));
} else {
  messages.push({ role: "user", content: "next turn", timestamp: 3 });
  await sample();
}
console.log("NATIVE_PI_OK");
