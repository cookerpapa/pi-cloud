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
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTrustedRemoteAgentTools as createRemoteTools,
  type TrustedRemoteToolsRuntimeConfiguration,
} from "../src/trusted-remote-tools.ts";
import { withToolInvocation } from "../src/tool-invocation.ts";

function createTrustedRemoteAgentTools(configuration: TrustedRemoteToolsRuntimeConfiguration) {
  const runtime = createRemoteTools(configuration);
  return {
    ...runtime,
    tools: runtime.tools.map((tool) => ({
      ...tool,
      execute: ((id, ...args) =>
        withToolInvocation({ id: `invocation-${id}`, nativeToolCallId: id }, async () => {
          const prepared = await tool.prepareExecution!(id, ...args);
          try {
            await configuration.publishToolCommand(prepared.command);
            return await prepared.result();
          } finally {
            prepared.dispose();
          }
        })) as typeof tool.execute,
    })),
    executeWorkflow: ((id, ...args) =>
      withToolInvocation({ id: `invocation-${id}`, nativeToolCallId: id }, () =>
        runtime.executeWorkflow(id, ...args),
      )) as typeof runtime.executeWorkflow,
  };
}

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
  let pending: { resolve(value: NativeToolEnd): void } | undefined;
  const publishToolCommand = vi.fn(async (command: CandidateToolCommand) => {
    expect(pending).toBeDefined(); // register BEFORE publication: even an immediate reply must not be lost
    pending!.resolve({
      type: "tool_execution_end",
      toolCallId: (command.request as { toolCallId: string }).toolCallId,
      toolName: command.request.toolName,
      isError: false,
      result: { content: [{ type: "text", text: "complete" }], details: { source: "guest" } },
    });
    return { operationId: command.request.operationId, accepted: true as const };
  });
  const value: TrustedRemoteToolsRuntimeConfiguration = {
    publishToolCommand,
    waitForToolReply: (_request, signal) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
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
  it("retires the image-adapter reply wait after publication fails without an unhandled rejection", async () => {
    let replySignal: AbortSignal | undefined;
    const { value } = configuration({
      publishToolCommand: async () => {
        throw new Error("publication failed");
      },
      // Production wraps the mailbox in an async attachment decoder, so the
      // mailbox's own rejection observer cannot handle this outer Promise.
      waitForToolReply: async (_request, signal) => {
        replySignal = signal;
        return await new Promise<NativeToolEnd>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    await expect(
      runtime.tools.find((t) => t.name === "read")!.execute("failed", { path: "a" }),
    ).rejects.toThrow("publication failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replySignal?.aborted).toBe(true);
  });

  it("observes early reply failure while publication is pending and never republishes the Tool", async () => {
    const publish = Promise.withResolvers<{ operationId: string; accepted: true }>();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<NativeToolEnd>();
    const publishToolCommand = vi.fn(async () => {
      started.resolve();
      return publish.promise;
    });
    const { value } = configuration({
      publishToolCommand,
      waitForToolReply: async () => reply.promise,
    });
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    const pending = runtime.tools.find((t) => t.name === "read")!.execute("early", { path: "a" });
    await started.promise;
    reply.reject(new Error("reply worker stopped"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    publish.resolve({ operationId: "probe", accepted: true });
    await expect(pending).rejects.toThrow("tool_operation_outcome_unknown");
    expect(publishToolCommand).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "makes image capability explicit before returning native content (supported=%s)",
    async (supported) => {
      const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
      const { value } = configuration({
        supportsImages: supported,
        publishToolCommand: async (command) => ({
          operationId: command.request.operationId,
          accepted: true,
        }),
        waitForToolReply: async (request) => ({
          type: "tool_execution_end",
          toolCallId: (request as { toolCallId: string }).toolCallId,
          toolName: "read",
          isError: false,
          result: { content: [image], details: undefined },
        }),
      });
      const runtime = createTrustedRemoteAgentTools(value);
      await runtime.transformContext([]);
      const tool = runtime.tools.find((t) => t.name === "read")!;
      const result = tool.execute("image", { path: "shot.png", detail: "original" });
      if (supported) await expect(result).resolves.toMatchObject({ content: [image] });
      else await expect(result).rejects.toThrow("does not support image input");
    },
  );
  it("lets Pi own final Tool events and after-Tool hooks, without adding progress to model context", async () => {
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
    ).toEqual(["tool_execution_start", "tool_execution_end"]);
    const result = agent.state.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "accepted by Worker hook" }],
    });
    expect(JSON.stringify(result)).not.toContain("working");
  });
  it.each(["read", "write", "edit", "bash"])(
    "publishes one %s command and returns only the final result without local execution",
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
      expect(update).not.toHaveBeenCalled();
      expect(publishToolCommand).toHaveBeenCalledTimes(1);
      expect(publishToolCommand.mock.calls[0]![0]).toMatchObject({
        toolCallId: "invocation-native-call",
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
    expect(
      runtime.tools
        .filter((tool) => tool.name !== "read")
        .every((tool) => tool.executionMode === "sequential"),
    ).toBe(true);
    expect(runtime.tools.find((tool) => tool.name === "read")!.executionMode).toBe("parallel");
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

  it.each([
    "reply timed out",
    "reply Worker stopped",
    "image decode failed",
    "reply identity mismatch",
  ])("stops native Agent sampling after transport rejection: %s", async (reason) => {
    const cause = new Error(reason);
    let failure: Error | undefined;
    const capture = createStepCapture();
    const unavailable = vi.fn((value: { code: string; message: string }) => {
      failure = new Error(value.code);
    });
    const publish = vi.fn(async (command: CandidateToolCommand) => ({
      operationId: command.request.operationId,
      accepted: true as const,
    }));
    const { value } = configuration({
      publishToolCommand: publish,
      waitForToolReply: async () => {
        throw cause;
      },
      onToolOperationUnavailable: unavailable,
      captureStepContext: (tools) => {
        if (failure) throw failure;
        return capture(tools);
      },
    });
    const remote = createTrustedRemoteAgentTools(value);
    const model = getModel("openai", "gpt-4o-mini");
    let requests = 0;
    const agent = new Agent({
      initialState: { model, tools: remote.tools, systemPrompt: "Fixture" },
      transformContext: (messages) => remote.transformContext(messages),
      streamFn: () => {
        const first = ++requests === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: first ? "toolUse" : "stop",
          content: first
            ? [
                {
                  type: "toolCall",
                  id: "uncertain",
                  name: "bash",
                  arguments: { command: "echo fixture" },
                },
              ]
            : [{ type: "text", text: "must not continue" }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
          (event) => event.type === "done",
          () => message,
        );
        queueMicrotask(() =>
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    });
    await agent.prompt("Execute once");
    expect(requests).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "tool_operation_outcome_unknown", retryable: false }),
    );
    expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("tool_operation_outcome_unknown") }],
    });
  });

  it("keeps an explicitly cancelled reply wait separate from infrastructure loss", async () => {
    const cancelled = new AbortController(),
      unavailable = vi.fn();
    const { value } = configuration({
      onToolOperationUnavailable: unavailable,
      publishToolCommand: async (command) => {
        cancelled.abort(new Error("user cancelled"));
        return { operationId: command.request.operationId, accepted: true };
      },
    });
    const remote = createTrustedRemoteAgentTools(value);
    await remote.transformContext([]);
    await expect(
      remote.tools
        .find((tool) => tool.name === "bash")!
        .execute("cancelled", { command: "echo fixture" }, cancelled.signal),
    ).rejects.toThrow("may still be running");
    expect(unavailable).not.toHaveBeenCalled();
  });
});
