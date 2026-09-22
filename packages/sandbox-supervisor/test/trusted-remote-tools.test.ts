import {
  EventStream,
  validateToolArguments,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  createExecutionReference,
  type CandidateToolCommand,
  type NativeToolEnd,
  type NativeToolUpdate,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTrustedRemoteAgentTools,
  type TrustedRemoteToolsRuntimeConfiguration,
} from "../src/trusted-remote-tools.ts";

const TURN_CONTEXT_SHA256 = "b".repeat(64);
const ATTEMPT_CONTEXT_SHA256 = "e".repeat(64);
const EXECUTION_LEASE = createExecutionReference(
  "10000000-0000-4000-8000-000000000010",
  "10000000-0000-4000-8000-000000000011",
  1,
);

function createStepCapture() {
  let sequence = 0;
  return (activeTools: readonly string[]) => {
    sequence += 1;
    const context = {
      schemaVersion: 2 as const,
      sequence,
      turnContextSha256: TURN_CONTEXT_SHA256,
      executionContextSha256: ATTEMPT_CONTEXT_SHA256,
      activeTools: [...activeTools].sort(),
      worldState: {
        sandbox: { status: "inactive" as const, continuitySha256: null },
        environmentSha256: "c".repeat(64),
        workspaceBindingSha256: "f".repeat(64),

        toolPolicySha256: "d".repeat(64),
      },
    };
    return {
      step: {
        context,
        sha256: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
      },
      modelMessages: [],
      samplingAttempt: 1,
    };
  };
}

function configuration(overrides: Partial<TrustedRemoteToolsRuntimeConfiguration> = {}) {
  let pending:
    { resolve(value: NativeToolEnd): void; update?: (value: NativeToolUpdate) => void } | undefined;
  const publishToolCommand = vi.fn(async (command: CandidateToolCommand) => {
    expect(pending).toBeDefined(); // register BEFORE publication: even an immediate reply must not be lost
    pending!.update?.({
      type: "tool_execution_update",
      toolCallId: command.toolCallId,
      toolName: command.request.toolName,
      args: {},
      partialResult: { content: [{ type: "text", text: "working" }], details: undefined },
    });
    pending!.resolve({
      type: "tool_execution_end",
      toolCallId: command.toolCallId,
      toolName: command.request.toolName,
      isError: false,
      result: { content: [{ type: "text", text: "complete" }], details: { source: "guest" } },
    });
    return { operationId: command.request.operationId, accepted: true as const };
  });
  const value: TrustedRemoteToolsRuntimeConfiguration = {
    publishToolCommand,
    waitForToolReply: (_request, signal, update) =>
      new Promise((resolve, reject) => {
        pending = { resolve, ...(update ? { update } : {}) };
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    workflowUrl: "http://127.0.0.1:4999/v1/tool-operations",
    activationId: "10000000-0000-4000-8000-000000000001",
    executionReference: EXECUTION_LEASE,
    turnContextSha256: TURN_CONTEXT_SHA256,
    executionContextSha256: ATTEMPT_CONTEXT_SHA256,
    captureStepContext: createStepCapture(),
    remainingToolCalls: 4,
    maximumToolOutputBytes: 65536,
    workingDirectory: "/workspace",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    ...overrides,
  };
  return { value, publishToolCommand };
}

describe("whole-tool Worker adapter", () => {
  it("lets Pi own native update/end events and after-Tool hooks, without adding progress to model context", async () => {
    const { value } = configuration();
    const runtime = createTrustedRemoteAgentTools(value);
    const events: AgentEvent[] = [];
    let sample = 0;
    const agent = new Agent({
      initialState: { model: getModel("openai", "gpt-4o-mini"), tools: [...runtime.tools] },
      transformContext: (messages) => runtime.transformContext(messages),
      afterToolCall: async () => ({ content: [{ type: "text", text: "accepted by Worker hook" }] }),
      streamFn: () => {
        const first = sample++ === 0;
        const message: AssistantMessage = {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4o-mini",
          timestamp: Date.now(),
          stopReason: first ? "toolUse" : "stop",
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "native-call",
                  name: "bash",
                  arguments: { command: "echo hello" },
                },
              ]
            : [{ type: "text", text: "done" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
          (event) => event.type === "done",
          (event) => (event.type === "done" ? event.message : message),
        );
        queueMicrotask(() =>
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt("exercise the remote tool");
    expect(
      events.filter((event) => event.type.startsWith("tool_execution_")).map((event) => event.type),
    ).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
    const result = agent.state.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "accepted by Worker hook" }],
    });
    expect(JSON.stringify(result)).not.toContain("working");
  });
  it.each(["read", "write", "edit", "bash"])(
    "publishes one %s command and forwards native updates/result without local execution",
    async (name) => {
      const { value, publishToolCommand } = configuration();
      const runtime = createTrustedRemoteAgentTools(value);
      await runtime.transformContext([]);
      const tool = runtime.tools.find((tool) => tool.name === name)!;
      const update = vi.fn();
      const args =
        name === "bash"
          ? { command: "echo hello" }
          : name === "edit"
            ? { path: "x", edits: [{ oldText: "a", newText: "b" }] }
            : name === "write"
              ? { path: "x", content: "a" }
              : { path: "x", offset: 3, limit: 4 };
      await expect(tool.execute("native-call", args, undefined, update)).resolves.toEqual({
        content: [{ type: "text", text: "complete" }],
        details: { source: "guest" },
      });
      expect(update).toHaveBeenCalledWith({
        content: [{ type: "text", text: "working" }],
        details: undefined,
      });
      expect(publishToolCommand).toHaveBeenCalledTimes(1);
      expect(publishToolCommand.mock.calls[0]![0]).toMatchObject({
        toolCallId: "native-call",
        request: { operation: "tool.execute", toolName: name, toolCallId: "native-call", args },
      });
    },
  );

  it.each([
    { timeout: undefined, ms: 300000 },
    { timeout: 0.1, ms: 100 },
    { timeout: 37.25, ms: 37250 },
  ])("retains Bash timeout semantics: %j", async ({ timeout, ms }) => {
    const { value, publishToolCommand } = configuration();
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    await runtime.tools
      .find((tool) => tool.name === "bash")!
      .execute("call", { command: "pwd", timeout });
    expect(publishToolCommand.mock.calls[0]![0].request).toMatchObject({ timeoutMs: ms });
  });

  it.each([0, -1, 0.05, 301, Infinity])(
    "rejects timeout %s before publication",
    async (timeout) => {
      const { value, publishToolCommand } = configuration();
      const runtime = createTrustedRemoteAgentTools(value);
      await runtime.transformContext([]);
      const bash = runtime.tools.find((tool) => tool.name === "bash")!;
      expect(() =>
        validateToolArguments(bash, {
          type: "toolCall",
          id: "bad",
          name: "bash",
          arguments: { command: "pwd", timeout },
        }),
      ).toThrow(/timeout/i);
      await expect(bash.execute("bad", { command: "pwd", timeout })).rejects.toThrow(/timeout/i);
      expect(publishToolCommand).not.toHaveBeenCalled();
    },
  );

  it.each(["cwd", "env", "timeuot"])("rejects undeclared Bash argument %s", (name) => {
    const bash = createTrustedRemoteAgentTools(configuration().value).tools.find(
      (tool) => tool.name === "bash",
    )!;
    expect(() =>
      validateToolArguments(bash, {
        type: "toolCall",
        id: "bad",
        name: "bash",
        arguments: { command: "pwd", [name]: "/elsewhere" },
      }),
    ).toThrow(new RegExp(name));
  });

  it("has no sandbox activation during prompt/context preparation", async () => {
    const { value } = configuration();
    delete value.activationId;
    delete value.workflowUrl;
    const resolveOperationTarget = vi.fn(async () => ({
      activationId: "10000000-0000-4000-8000-000000000077",
      workflowUrl: "http://broker/workflow",
    }));
    value.resolveOperationTarget = resolveOperationTarget;
    const runtime = createTrustedRemoteAgentTools(value);
    expect(runtime.tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    await expect(runtime.systemPrompt("Current working directory: /trusted")).resolves.toContain(
      "Current working directory: /workspace",
    );
    await runtime.transformContext([]);
    expect(resolveOperationTarget).not.toHaveBeenCalled();
    await runtime.tools.find((tool) => tool.name === "read")!.execute("read", { path: "a" });
    expect(resolveOperationTarget).toHaveBeenCalledOnce();
  });

  it("keeps immutable capabilities, Tool budget and clean sampling boundaries", async () => {
    const { value, publishToolCommand } = configuration({
      allowedTools: ["read", "bash"],
      remainingToolCalls: 1,
    });
    const runtime = createTrustedRemoteAgentTools(value);
    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
    await expect(runtime.tools[0]!.execute("early", { path: "a" })).rejects.toThrow(
      "step_context_unavailable",
    );
    expect(publishToolCommand).not.toHaveBeenCalled();
    await expect(runtime.tools[0]!.execute("exhausted", { path: "a" })).rejects.toThrow(
      "tool_budget_exhausted",
    );
  });

  it("refreshes maintenance sampling identities and retains trace headers", async () => {
    const purposes: Array<string | undefined> = [],
      capture = createStepCapture();
    const { value } = configuration({
      captureStepContext: (tools, purpose) => {
        purposes.push(purpose);
        return capture(tools);
      },
    });
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    expect(await runtime.transformHeaders({ "x-test": "yes" })).toMatchObject({
      "x-test": "yes",
      "x-pi-cloud-step-sequence": "1",
      traceparent: value.traceparent,
    });
    expect(await runtime.transformHeaders()).toMatchObject({ "x-pi-cloud-step-sequence": "2" });
    await runtime.transformContext([]);
    expect(await runtime.transformHeaders()).toMatchObject({ "x-pi-cloud-step-sequence": "3" });
    expect(purposes).toEqual(["agent", "context_maintenance", "agent"]);
  });

  it("preserves one model-visible world-state fact across repeated context boundaries", async () => {
    const capture = createStepCapture();
    const runtime = createTrustedRemoteAgentTools(
      configuration({
        captureStepContext: (tools) => ({
          ...capture(tools),
          modelMessages: [
            {
              customType: "pi-cloud.sandbox_reset",
              content: "<sandbox_reset>reset</sandbox_reset>",
              display: false,
              details: { schemaVersion: 1, changeSha256: "e".repeat(64) },
            },
          ],
        }),
      }).value,
    );
    const first = await runtime.transformContext([]);
    expect(first).toHaveLength(1);
    expect(await runtime.transformContext(first)).toHaveLength(1);
  });

  it("preserves UNKNOWN as an error and marks unavailable execution state", async () => {
    const unavailable = vi.fn();
    const { value } = configuration({
      onToolOperationUnavailable: unavailable,
      waitForToolReply: async (request) => ({
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: request.toolName,
        isError: true,
        result: {
          content: [{ type: "text", text: "cubesandbox_tool_result_unknown: No confirmed result" }],
          details: undefined,
        },
      }),
      publishToolCommand: async (command) => ({
        operationId: command.request.operationId,
        accepted: true,
      }),
    });
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    await expect(
      runtime.tools.find((tool) => tool.name === "bash")!.execute("call", { command: "migrate" }),
    ).rejects.toThrow("cubesandbox_tool_result_unknown");
    expect(unavailable).toHaveBeenCalledOnce();
  });
});
