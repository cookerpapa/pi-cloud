// Reproduces named review observations; these assertions describe the audit baseline, not desired behavior.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const { Session, InMemorySessionStorage, buildSessionContext, convertToLlm } = await import(
  root + "/node_modules/@earendil-works/pi-agent-core/dist/index.js"
);
const { EventStream } = await import(root + "/node_modules/@earendil-works/pi-ai/dist/index.js");
const { transformMessages } = await import(
  root + "/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js"
);
const { CloudAgentRuntime } = await import(
  root + "/packages/sandbox-supervisor/src/cloud-agent-runtime.ts"
);
const { createTrustedRemoteAgentTools } = await import(
  root + "/packages/sandbox-supervisor/src/trusted-remote-tools.ts"
);
const { createExecutionReference } = await import(
  root + "/packages/protocol/src/execution-reference.ts"
);
const model = {
  id: "gpt-6-luna",
  name: "Review fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const authority = () => ({
  signal: new AbortController().signal,
  assertCurrent: async () => {},
  close: async () => {},
});
function response(content, stopReason = "stop") {
  const msg = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage,
    ...(stopReason === "error" ? { errorMessage: "synthetic permanent model failure" } : {}),
  };
  const stream = new EventStream(
    (e) => e.type === "done" || e.type === "error",
    (e) => e.message ?? e.error,
  );
  queueMicrotask(() => {
    stream.push({ type: "start", partial: msg });
    stream.push(
      stopReason === "error" || stopReason === "aborted"
        ? { type: "error", reason: stopReason, error: msg }
        : { type: "done", reason: stopReason, message: msg },
    );
    stream.end(msg);
  });
  return stream;
}
const report = {
  piVersion: JSON.parse(
    await readFile(root + "/node_modules/@earendil-works/pi-agent-core/package.json", "utf8"),
  ).version,
  model: "synthetic; no provider request or shell execution",
  toolFailures: [],
  interruptedPrefixes: [],
};
for (const mode of ["broker-error", "reply-rejection", "assistant-own-proto"]) {
  const session = new Session(
    new InMemorySessionStorage({ id: crypto.randomUUID(), createdAt: Date.now() }),
  );
  let requests = 0,
    unavailable = 0,
    failure,
    sequence = 0,
    publications = 0;
  const remote = createTrustedRemoteAgentTools({
    executionReference: createExecutionReference(
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      1,
    ),
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    remainingToolCalls: 10,
    maximumToolOutputBytes: 65536,
    workingDirectory: "/workspace",
    workflowUrl: "http://invalid/workflow",
    activationId: "10000000-0000-4000-8000-000000000003",
    publishToolCommand: async (c) => ({ operationId: c.request.operationId, accepted: true }),
    waitForToolReply: async (r) => {
      if (mode === "reply-rejection") throw Error("reply wait expired");
      return {
        type: "tool_execution_end",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        isError: true,
        result: {
          content: [{ type: "text", text: "cubesandbox_tool_result_unknown: No confirmed result" }],
          details: {},
        },
      };
    },
    onToolOperationUnavailable: async (error) => {
      unavailable++;
      failure = Error(error.message);
    },
    captureStepContext: async (tools) => {
      if (failure) throw failure;
      return {
        step: {
          sha256: "c".repeat(64),
          context: {
            sequence: ++sequence,
            turnContextSha256: "a".repeat(64),
            executionContextSha256: "b".repeat(64),
            activeTools: tools,
          },
        },
        modelMessages: [],
        samplingAttempt: 1,
      };
    },
  });
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    authority: authority(),
    model,
    systemPrompt: "Fixture",
    tools: remote.tools,
    transformContext: remote.transformContext,
    transformHeaders: remote.transformHeaders,
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    streamFn: () => {
      requests++;
      return requests === 1
        ? response(
            [
              {
                type: "toolCall",
                id: "tool-1",
                name: "bash",
                arguments:
                  mode === "assistant-own-proto"
                    ? JSON.parse('{"command":"echo fixture","__proto__":{"marker":"must-survive"}}')
                    : { command: "echo fixture" },
              },
            ],
            "toolUse",
          )
        : response([{ type: "text", text: "continued-after-error" }]);
    },
    commitCheckpoint: async (op, _event, pub) => {
      if (pub?.toolCommand) publications++;
      for (const item of op.items) {
        if (item.kind === "append_entry") await session.appendEntry(item.entry, item.lane);
        else await session.appendRecord(item.record);
      }
    },
  });
  let outcome;
  let outcomeError;
  try {
    const result = await runtime.run("Probe the Tool failure boundary");
    outcome = result.kind;
    outcomeError = result.error;
  } catch (e) {
    outcome = "threw:" + e.message;
  }
  const observation = { mode, requests, unavailable, publications, outcome };
  if (mode === "assistant-own-proto")
    report.opaqueAssistantArguments = { ...observation, error: outcomeError };
  else report.toolFailures.push(observation);
}
for (const reason of ["stop", "error", "aborted"]) {
  const session = new Session(
    new InMemorySessionStorage({ id: crypto.randomUUID(), createdAt: Date.now() }),
  );
  const options = {
    session,
    lane: "main",
    authority: authority(),
    model,
    systemPrompt: "Fixture",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
  };
  const marker = "VISIBLE_PREFIX_REVIEW_20260930";
  const first = new CloudAgentRuntime({
    ...options,
    streamFn: () => response([{ type: "text", text: marker }], reason),
  });
  const firstResult = await first.run("first");
  let rawHasPrefix = false,
    providerHasPrefix = false;
  const second = new CloudAgentRuntime({
    ...options,
    authority: authority(),
    streamFn: (_model, context) => {
      rawHasPrefix = JSON.stringify(context.messages).includes(marker);
      providerHasPrefix = JSON.stringify(transformMessages(context.messages, model)).includes(
        marker,
      );
      return response([{ type: "text", text: "second" }]);
    },
  });
  await second.run("continue");
  const entries = await session.findEntriesOnBranch();
  report.interruptedPrefixes.push({
    reason,
    firstOutcome: firstResult.kind,
    historyHasPrefix: JSON.stringify(entries).includes(marker),
    rawHasPrefix,
    providerHasPrefix,
  });
}
{
  const session = new Session(
    new InMemorySessionStorage({ id: crypto.randomUUID(), createdAt: Date.now() }),
  );
  let calls = 0;
  const details = JSON.parse('{"__proto__":{"marker":"must-survive"},"regular":1}');
  const tool = {
    name: "fixture",
    label: "Fixture",
    description: "Fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "done" }], details }),
  };
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    authority: authority(),
    model,
    systemPrompt: "Fixture",
    tools: [tool],
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    streamFn: () =>
      ++calls === 1
        ? response(
            [{ type: "toolCall", id: "detail-call", name: "fixture", arguments: {} }],
            "toolUse",
          )
        : response([{ type: "text", text: "done" }]),
  });
  const outcome = await runtime.run("Return opaque metadata");
  const entry = (await session.findEntriesOnBranch()).find(
    (e) => e.type === "message" && e.message.role === "toolResult",
  );
  report.opaqueDetails = {
    inputOwnProto: Object.hasOwn(details, "__proto__"),
    storedOwnProto: entry ? Object.hasOwn(entry.message.details, "__proto__") : null,
    input: JSON.stringify(details),
    stored: JSON.stringify(entry?.message.details),
    outcome: outcome.kind,
    error: outcome.error,
    roles: (await session.findEntriesOnBranch()).map((e) =>
      e.type === "message" ? e.message.role : e.type,
    ),
  };
}
const { createCloudSubagentTool } = await import(
  root + "/packages/sandbox-supervisor/src/subagent-tool.ts"
);
const { MAX_EXECUTION_FACT_BYTES } = await import(root + "/packages/protocol/src/index.ts");
report.subagentInputBudgets = [];
for (const length of [200000, 400000]) {
  const task = "x".repeat(length),
    tool = createCloudSubagentTool({});
  tool.prepareArguments({ action: "run", task, context: "fresh" });
  let bytes = 0;
  const session = new Session(
    new InMemorySessionStorage({ id: crypto.randomUUID(), createdAt: Date.now() }),
  );
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    authority: authority(),
    model,
    systemPrompt: "Fixture",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    streamFn: () => {
      throw Error("No model request belongs to this size probe");
    },
    commitCheckpoint: async (op) => {
      bytes ||= Buffer.byteLength(JSON.stringify(op));
      throw Error("Capture only, no publication");
    },
  });
  await runtime.run(task).catch(() => {});
  report.subagentInputBudgets.push({
    characters: length,
    argumentsAccepted: true,
    startupOperationBytes: bytes,
    executionFactLimit: MAX_EXECUTION_FACT_BYTES,
    exceedsLimitBeforeEnvelope: bytes > MAX_EXECUTION_FACT_BYTES,
  });
}
assert.equal(report.subagentInputBudgets[1].exceedsLimitBeforeEnvelope, true);
const baseline = new Session(
  new InMemorySessionStorage({ id: crypto.randomUUID(), createdAt: Date.now() }),
);
const nativeDetails = JSON.parse('{"__proto__":{"marker":"must-survive"},"regular":1}');
await baseline.appendMessage({
  role: "toolResult",
  toolCallId: "fixture",
  toolName: "fixture",
  content: [{ type: "text", text: "done" }],
  details: nativeDetails,
  isError: false,
  timestamp: Date.now(),
});
const [nativeEntry] = await baseline.findEntriesOnBranch();
report.opaqueDetails.nativeStorageOwnProto = Object.hasOwn(
  nativeEntry.message.details,
  "__proto__",
);
assert.equal(report.toolFailures[0].requests, 1);
assert.equal(report.toolFailures[1].requests, 2);
assert.equal(report.opaqueDetails.nativeStorageOwnProto, true);
assert.equal(report.opaqueDetails.outcome, "failed");
assert.equal(report.opaqueAssistantArguments.outcome, "failed");
assert.equal(report.opaqueAssistantArguments.publications, 0);
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-review-native.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
