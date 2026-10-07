import { CloudModelRegistry } from "../../../packages/sandbox-supervisor/src/durable/model-registry.ts";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { writeFile } from "node:fs/promises";
const registry = new CloudModelRegistry();
const model = registry.configure({
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  api: "openai-codex-responses",
  baseUrl: "http://owned-test.invalid",
  apiKey: "not-stored",
  reasoning: true,
});
const key =
  "test." +
  Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "owned-review-fixture" },
    }),
  ).toString("base64url") +
  ".test";
const cases = [];
for (const message of ["Request could not be completed", "Internal server error"]) {
  let requests = 0;
  const result = await registry.models.completeSimple(
    model,
    { messages: [{ role: "user", content: "test", timestamp: 0 }] },
    {
      apiKey: key,
      transport: "sse",
      maxRetries: 0,
      fetch: async () => {
        requests++;
        return new Response(
          JSON.stringify({ error: { message, type: "server_error", code: "server_error" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  cases.push({
    inputStatus: 500,
    message,
    requests,
    errorMessage: result.errorMessage,
    stopReason: result.stopReason,
    nativeRetryable: isRetryableAssistantError(result),
  });
}
const result = {
  scope: "Pinned Pi provider and retry classifier, intercepted fetch only; no paid request",
  priorLiveFailureBodyKnown: false,
  cases,
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-model-error-classification.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
