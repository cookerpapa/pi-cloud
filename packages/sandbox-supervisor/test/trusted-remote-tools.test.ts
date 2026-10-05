import { ToolExecutionFailure } from "@pi-cloud/protocol";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  hook,
  ToolTask,
  watchEvents,
  type AgentEvent,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nativeToolApi } from "./tool-api.ts";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";
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
      execute: (async (args, api, context) =>
        withToolInvocation(
          { id: `invocation-${api.callId}`, nativeToolCallId: api.callId },
          async () => {
            const prepared = await tool.prepareExecution!(api.callId, args, context.abortSignal);
            try {
              await configuration.publishToolCommand(prepared.command);
              return await prepared.result();
            } finally {
              prepared.dispose();
            }
          },
        )) as typeof tool.execute,
    })),
    executeWorkflow: ((id, ...args) =>
      withToolInvocation({ id: `invocation-${id}`, nativeToolCallId: id }, () =>
        runtime.executeWorkflow(id, ...args),
      )) as typeof runtime.executeWorkflow,
  };
}

async function runNativeRemote(
  runtime: ReturnType<typeof createTrustedRemoteAgentTools>,
  replace = false,
) {
  const provider = fauxProvider({ tokensPerSecond: 1000000 }),
    source = createModels();
  source.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo fixture" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const scoped = new ScopedDurableModels(source, async (request) => {
    const context = request.input as { messages: import("@earendil-works/pi-ai").Message[] };
    const messages = await runtime.transformContext(context.messages);
    return {
      model: provider.getModel(),
      input: { ...context, messages },
      options: request.options,
      release: () => {},
    };
  });
  const model = scoped.register(crypto.randomUUID(), provider.getModel());
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "fixture",
      tools: runtime.tools,
      hooks: replace
        ? [
            hook(ToolTask, {
              afterTool: () => ({ content: [{ type: "text", text: "accepted by Worker hook" }] }),
            }),
          ]
        : [],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: scoped.models,
      registry,
      settings: { retry: { maxRetries: 0 }, compaction: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.configure({ model, tools: runtime.tools }, BACKGROUND_CONTEXT);
    const events: AgentEvent[] = [],
      stream = await watchEvents(harness, root.id, BACKGROUND_CONTEXT);
    stream.start(async (batch) => {
      events.push(...batch);
    });
    const input = await root.submit({ type: "input", content: "Execute once" }, BACKGROUND_CONTEXT);
    await input.wait(BACKGROUND_CONTEXT);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "tool_execution_end")).toBe(true),
    );
    const messages = (await root.context(BACKGROUND_CONTEXT)).messages;
    await stream.stop();
    return { events, messages, requests: provider.state.callCount };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
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
    trackWorkflowOperation: () => {},
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
      runtime.tools
        .find((t) => t.name === "read")!
        .execute({ path: "a" }, nativeToolApi("failed"), BACKGROUND_CONTEXT),
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
    const pending = runtime.tools
      .find((t) => t.name === "read")!
      .execute({ path: "a" }, nativeToolApi("early"), BACKGROUND_CONTEXT);
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
      const result = tool.execute(
        { path: "shot.png", detail: "original" },
        nativeToolApi("image"),
        BACKGROUND_CONTEXT,
      );
      if (supported) await expect(result).resolves.toMatchObject({ content: [image] });
      else await expect(result).rejects.toThrow("does not support image input");
    },
  );
  it("lets Pi own final Tool events and after-Tool hooks, without adding progress to model context", async () => {
    const { value } = configuration();
    const runtime = createTrustedRemoteAgentTools(value);
    const { events, messages } = await runNativeRemote(runtime, true);
    expect(
      events.filter((event) => event.type.startsWith("tool_execution_")).map((event) => event.type),
    ).toEqual(["tool_execution_start", "tool_execution_end"]);
    const result = messages.find((message) => message.role === "toolResult");
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
      await expect(
        tool.execute(args, nativeToolApi("native-call"), BACKGROUND_CONTEXT),
      ).resolves.toEqual({
        content: [{ type: "text", text: "complete" }],
        details: { source: "guest" },
        isError: false,
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
      .execute({ command: "pwd", timeout }, nativeToolApi("call"), BACKGROUND_CONTEXT);
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
      await expect(
        bash.execute({ command: "pwd", timeout }, nativeToolApi("bad"), BACKGROUND_CONTEXT),
      ).rejects.toThrow(/timeout/i);
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
    await runtime.tools
      .find((tool) => tool.name === "read")!
      .execute({ path: "a" }, nativeToolApi("read"), BACKGROUND_CONTEXT);
    expect(resolveOperationTarget).toHaveBeenCalledOnce();
  });

  it("keeps immutable capabilities, Tool budget and clean sampling boundaries", async () => {
    const { value, publishToolCommand } = configuration({
      allowedTools: ["read", "bash"],
      remainingToolCalls: 1,
    });
    const runtime = createTrustedRemoteAgentTools(value);
    expect(runtime.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
    await expect(
      runtime.tools[0]!.execute({ path: "a" }, nativeToolApi("early"), BACKGROUND_CONTEXT),
    ).resolves.toMatchObject({ isError: false });
    expect(publishToolCommand).toHaveBeenCalledOnce();
    await expect(
      runtime.tools[0]!.execute({ path: "a" }, nativeToolApi("exhausted"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("tool_budget_exhausted");
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
      waitForToolReply: async () => {
        throw new ToolExecutionFailure({
          code: "cubesandbox_tool_result_unknown",
          message: "No confirmed result",
          effect: "unknown",
        });
      },
      publishToolCommand: async (command) => ({
        operationId: command.request.operationId,
        accepted: true,
      }),
    });
    const runtime = createTrustedRemoteAgentTools(value);
    await runtime.transformContext([]);
    await expect(
      runtime.tools
        .find((tool) => tool.name === "bash")!
        .execute({ command: "migrate" }, nativeToolApi("call"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("cubesandbox_tool_result_unknown");
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it.each([
    "reply timed out",
    "reply Worker stopped",
    "image decode failed",
    "reply identity mismatch",
    "structured failure",
  ])("stops native Agent sampling after transport rejection: %s", async (reason) => {
    const cause =
      reason === "structured failure"
        ? new ToolExecutionFailure({
            code: "ownership_lost",
            message: "Executor no longer owns this operation",
            effect: "unknown",
          })
        : new Error(reason);
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
    const result = await runNativeRemote(remote);
    expect(result.requests).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: reason === "structured failure" ? "ownership_lost" : "tool_operation_outcome_unknown",
        retryable: false,
      }),
    );
    expect(result.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            reason === "structured failure" ? "ownership_lost" : "tool_operation_outcome_unknown",
          ),
        },
      ],
    });
  });
});
