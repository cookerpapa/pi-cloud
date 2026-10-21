import { serviceAddress } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import sharp from "sharp";

if (process.env.PI_CLOUD_LIVE_GPT6_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_GPT6_CHECK=1 to permit reviewed GPT vision/Tool/search token usage",
  );
const runtime = "deploy/production/runtime";
const key = (await readFile(`${runtime}/secrets/cli-proxy-api-key`, "utf8")).trim();
const ip = serviceAddress("cli-proxy-api");
const model = process.env.PI_CLOUD_GPT_CAPABILITY_MODEL ?? "gpt-6-luna";
assert(["gpt-6-luna", "gpt-6.1-sol"].includes(model), "Unreviewed acceptance model");
const output = process.argv[2] ?? `dist/gpt6-capabilities-${model}.json`;
async function call(input, tools = [], extra = {}) {
  const response = await fetch(`http://${ip}:8317/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "session-id": `image-capability-${randomUUID()}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      store: false,
      instructions: "Follow the request exactly and be concise.",
      input,
      tools,
      reasoning: { effort: "low" },
      ...extra,
    }),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200, `GPT-6 capability HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.model, model);
  assert.equal(result.status, "completed");
  return result;
}
const text = (r) =>
  (r.output ?? [])
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("");
const tools = [
  {
    type: "function",
    name: "read_test_image",
    description: "Read the test screenshot.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];
const prompt = {
  role: "user",
  content:
    "Call read_test_image once. Then read the four large digits in the returned image. Answer only those four digits.",
};
const first = await call([prompt], tools, {
  tool_choice: { type: "function", name: "read_test_image" },
});
const calls = first.output.filter((x) => x.type === "function_call");
assert.equal(calls.length, 1);
assert.equal(calls[0].name, "read_test_image");
const overlay = Buffer.from(
  '<svg width="1100" height="1100"><rect x="150" y="350" width="800" height="350" fill="white"/><text x="550" y="605" text-anchor="middle" font-family="sans-serif" font-size="220" font-weight="bold" fill="black">7392</text></svg>',
);
const image = await sharp(randomBytes(1100 * 1100 * 3), {
  raw: { width: 1100, height: 1100, channels: 3 },
})
  .composite([{ input: overlay }])
  .png()
  .toBuffer();
assert(image.length > 1024 * 1024);
const second = await call(
  [
    prompt,
    ...first.output,
    {
      type: "function_call_output",
      call_id: calls[0].call_id,
      output: [
        { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` },
      ],
    },
  ],
  tools,
  { tool_choice: "none" },
);
assert.equal(text(second).trim(), "7392");
const search = await call(
  [
    {
      role: "user",
      content:
        "Use web search to find the current latest stable Node.js release from nodejs.org. Cite its URL in one sentence. Do not answer from memory.",
    },
  ],
  [{ type: "web_search" }],
);
const searchCalls = search.output.filter((x) => x.type === "web_search_call");
assert(searchCalls.length > 0, "No actual hosted search call occurred");
const fast = await call([{ role: "user", content: "Reply exactly FAST_MODE_OK." }], [], {
  reasoning: { effort: "medium" },
  service_tier: "fast",
});
assert.equal(text(fast).trim(), "FAST_MODE_OK");
const report = {
  checkedAt: new Date().toISOString(),
  model,
  functionCalling: true,
  toolResultVision: true,
  imageBytes: image.length,
  imageSha256: createHash("sha256").update(image).digest("hex"),
  visionAnswerCorrect: true,
  hostedSearchCalls: searchCalls.length,
  fastRequestAccepted: true,
  fastResponseServiceTier: fast.service_tier ?? null,
  usage: [first, second, search, fast].map((r) => ({
    input: r.usage?.input_tokens,
    output: r.usage?.output_tokens,
  })),
  accepted: true,
};
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
