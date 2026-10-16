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
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
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
  type TrustedRemoteToolsRuntimeConfiguration as BaseConfiguration,
} from "../src/trusted-remote-tools.ts";
import { withToolInvocation } from "../src/tool-invocation.ts";

type TrustedRemoteToolsRuntimeConfiguration = BaseConfiguration & {
  publishToolCommand(
    command: CandidateToolCommand,
  ): Promise<{ operationId: string; accepted: true }>;
};

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
              if (!("request" in prepared.command)) throw new Error("Expected the Cube fixture");
              await configuration.publishToolCommand(prepared.command);
              return await prepared.result();
            } finally {
              prepared.dispose();
            }
          },
        )) as typeof tool.execute,
    })),
  };
}

async function runNativeRemote(
  runtime: ReturnType<typeof createTrustedRemoteAgentTools>,
  replace = false,
  call = fauxToolCall("bash", { command: "echo fixture" }),
  inspection?: ReturnType<typeof fauxToolCall>,
) {
  const provider = fauxProvider({ tokensPerSecond: 1000000 }),
    source = createModels();
  source.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(call, {
      stopReason: "toolUse",
    }),
    ...(inspection ? [fauxAssistantMessage(inspection, { stopReason: "toolUse" })] : []),
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
  const model = scoped.register(crypto.randomUUID(), 1, provider.getModel());
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

function guardedConfiguration(overrides: Partial<TrustedRemoteToolsRuntimeConfiguration>) {
  let failure: Error | undefined;
  const capture = createStepCapture();
  const unavailable = vi.fn((value: { code: string }) => {
    failure = new Error(value.code);
  });
  return {
    ...configuration({
      captureStepContext: (tools) => {
        if (failure) throw failure;
        return capture(tools);
      },
      onToolOperationUnavailable: unavailable,
      publishToolCommand: async (command) => ({
        operationId: command.request.operationId,
        accepted: true,
      }),
      ...overrides,
    }),
    unavailable,
  };
}

it("adds no readiness request to an ordinary confirmed Tool result", async () => {
  const confirm = vi.fn(async () => true);
  const f = configuration({ confirmExecution: confirm });
  const result = await runNativeRemote(createTrustedRemoteAgentTools(f.value));
  expect(result.requests).toBe(2);
  expect(confirm).not.toHaveBeenCalled();
});

it("shares one readiness decision across concurrent uncertain fixed Tools", async () => {
  const ready = Promise.withResolvers<boolean>(),
    confirm = vi.fn(() => ready.promise);
  const f = guardedConfiguration({
    confirmExecution: confirm,
    waitForToolReply: async () => {
      throw new ToolExecutionFailure({
        code: "tool_reply_timeout",
        effect: "unknown",
        message: "No final reply",
      });
    },
  });
  const read = createTrustedRemoteAgentTools(f.value).tools.find((t) => t.name === "read")!;
  const pending = Promise.allSettled([
    read.execute({ path: "a" }, nativeToolApi("a"), BACKGROUND_CONTEXT),
    read.execute({ path: "b" }, nativeToolApi("b"), BACKGROUND_CONTEXT),
  ]);
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  ready.resolve(true);
  expect((await pending).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(f.unavailable).not.toHaveBeenCalled();
});

it("commits UNKNOWN through native Pi then permits a distinct inspection without replay", async () => {
  const confirm = vi.fn(async () => true);
  let executions = 0;
  const publish = vi.fn(async (command: CandidateToolCommand) => {
    if (command.request.toolName === "bash") executions++;
    return { operationId: command.request.operationId, accepted: true as const };
  });
  const f = guardedConfiguration({
    confirmExecution: confirm,
    publishToolCommand: publish,
    waitForToolReply: async (request, _signal, callId) => {
      if (request.toolName === "bash")
        throw new ToolExecutionFailure({
          code: "tool_handoff_unconfirmed",
          effect: "unknown",
          message: "Inspect effects before repeating the operation",
        });
      return {
        type: "tool_execution_end",
        toolCallId: callId!,
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "hello" }] },
      };
    },
  });
  const result = await runNativeRemote(
    createTrustedRemoteAgentTools(f.value),
    false,
    fauxToolCall("bash", { command: "echo hello >> notes.txt" }),
    fauxToolCall("read", { path: "notes.txt" }),
  );
  expect(result.requests).toBe(3);
  expect(executions).toBe(1);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledOnce();
  expect(f.unavailable).not.toHaveBeenCalled();
  const outcomes = result.messages.filter((m) => m.role === "toolResult");
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]).toMatchObject({
    isError: true,
    content: [{ type: "text", text: expect.stringContaining("tool_handoff_unconfirmed") }],
  });
  expect(outcomes[1]).toMatchObject({ isError: false, content: [{ type: "text", text: "hello" }] });
  expect(JSON.stringify(result.messages)).not.toMatch(
    /probeId|targetId|execution_probe|execution-readiness/,
  );
});

it.each([false, "throws"])(
  "interrupts native sampling when readiness cannot be confirmed: %s",
  async (ready) => {
    const f = guardedConfiguration({
      confirmExecution: async () => {
        if (ready === "throws") throw new Error("confirmation connection lost");
        return false;
      },
      waitForToolReply: async () => {
        throw new ToolExecutionFailure({
          code: "tool_reply_timeout",
          effect: "unknown",
          message: "No confirmed final reply",
        });
      },
    });
    const result = await runNativeRemote(createTrustedRemoteAgentTools(f.value));
    expect(result.requests).toBe(1);
    expect(f.unavailable).toHaveBeenCalledOnce();
  },
);

it.each([
  "ownership_lost",
  "stale_session_lease",
  "cubesandbox_tool_unavailable",
  "tool_reply_protocol_error",
  "cubesandbox_tool_result_unknown",
  "workflow_result_unknown",
])("never probes away a hard failure: %s", async (code) => {
  const confirm = vi.fn(async () => true);
  const f = guardedConfiguration({
    confirmExecution: confirm,
    waitForToolReply: async () => {
      throw new ToolExecutionFailure({
        code,
        effect: "unknown",
        message: "Execution cannot continue",
      });
    },
  });
  const result = await runNativeRemote(createTrustedRemoteAgentTools(f.value));
  expect(result.requests).toBe(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(f.unavailable).toHaveBeenCalledOnce();
});

it("interrupts a second UNKNOWN instead of looping on successful small probes", async () => {
  const confirm = vi.fn(async () => true);
  const f = guardedConfiguration({
    confirmExecution: confirm,
    waitForToolReply: async () => {
      throw new ToolExecutionFailure({
        code: "tool_reply_timeout",
        effect: "unknown",
        message: "Reply missing",
      });
    },
  });
  const result = await runNativeRemote(
    createTrustedRemoteAgentTools(f.value),
    false,
    fauxToolCall("bash", { command: "echo hello >> notes.txt" }),
    fauxToolCall("read", { path: "notes.txt" }),
  );
  expect(result.requests).toBe(2);
  expect(confirm).toHaveBeenCalledOnce();
  expect(f.unavailable).toHaveBeenCalledOnce();
});

it("resets the uncertainty guard after a confirmed native result", async () => {
  const confirm = vi.fn(async () => true);
  let call = 0;
  const f = guardedConfiguration({
    confirmExecution: confirm,
    waitForToolReply: async (request, _signal, id) => {
      if (++call === 2)
        return {
          type: "tool_execution_end",
          toolCallId: id!,
          toolName: request.toolName,
          isError: true,
          result: { content: [{ type: "text", text: "File does not exist" }] },
        };
      throw new ToolExecutionFailure({
        code: "tool_reply_timeout",
        effect: "unknown",
        message: "Reply missing",
      });
    },
  });
  const runtime = createTrustedRemoteAgentTools(f.value),
    read = runtime.tools.find((t) => t.name === "read")!;
  await expect(
    read.execute({ path: "a" }, nativeToolApi("one"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("tool_reply_timeout");
  await expect(
    read.execute({ path: "b" }, nativeToolApi("two"), BACKGROUND_CONTEXT),
  ).resolves.toMatchObject({ isError: true });
  await expect(
    read.execute({ path: "c" }, nativeToolApi("three"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("tool_reply_timeout");
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(f.unavailable).not.toHaveBeenCalled();
});

it("Stop during readiness prevents native continuation even if the probe succeeds", async () => {
  const check = Promise.withResolvers<boolean>(),
    stop = new AbortController();
  const confirm = vi.fn(() => check.promise);
  const f = guardedConfiguration({
    confirmExecution: confirm,
    waitForToolReply: async () => {
      throw new ToolExecutionFailure({
        code: "tool_reply_timeout",
        effect: "unknown",
        message: "Reply missing",
      });
    },
  });
  const runtime = createTrustedRemoteAgentTools(f.value);
  const pending = runtime.tools
    .find((t) => t.name === "read")!
    .execute(
      { path: "a" },
      nativeToolApi("stop"),
      withAbortSignal(stop.signal, BACKGROUND_CONTEXT),
    );
  const rejected = expect(pending).rejects.toThrow("User stopped");
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  stop.abort(new Error("User stopped"));
  check.resolve(true);
  await rejected;
  expect(f.unavailable).not.toHaveBeenCalled();
});

it.each([
  ["read", { path: "a" }, 180_000],
  ["bash", { command: "sleep 1", timeout: 30 }, 150_000],
  ["bash", { command: "sleep 1" }, 420_000],
] as const)(
  "uses the invocation budget for %s and preserves typed deadline failure",
  async (name, args, budget) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const waiting = Promise.withResolvers<void>();
    const f = guardedConfiguration({
      waitForToolReply: async (_request, signal) => {
        waiting.resolve();
        return await new Promise<NativeToolEnd>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    try {
      const runtime = createTrustedRemoteAgentTools(f.value);
      const pending = runtime.tools
        .find((t) => t.name === name)!
        .execute(args, nativeToolApi("timeout"), BACKGROUND_CONTEXT);
      const rejected = expect(pending).rejects.toThrow("tool_reply_timeout");
      await waiting.promise;
      expect(timeout).toHaveBeenCalledWith(budget);
      deadline.abort(new DOMException("Time expired", "TimeoutError"));
      await rejected;
      expect(f.unavailable).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  },
);

describe("whole-tool Worker adapter", () => {
  it("retains Read diagnostics through the Worker and native Harness at the full content budget", async () => {
    const text = "x".repeat(51200);
    const diagnostic = {
      severity: "warn" as const,
      code: "truncated",
      message: "Use bash: sed -n '1p' bundle.js | tail -c +51201",
    };
    const { value } = configuration({
      publishToolCommand: async (command) => ({
        operationId: command.request.operationId,
        accepted: true,
      }),
      waitForToolReply: async (request) => ({
        type: "tool_execution_end",
        toolCallId: (request as { toolCallId: string }).toolCallId,
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text }], diagnostics: [diagnostic] },
      }),
    });
    const runtime = createTrustedRemoteAgentTools(value);
    const result = await runNativeRemote(
      runtime,
      false,
      fauxToolCall("read", { path: "bundle.js" }),
    );
    const message = result.messages.find((m) => m.role === "toolResult");
    expect(message).toMatchObject({
      toolName: "read",
      isError: false,
      content: [
        { type: "text", text },
        { type: "text", text: `<harness>\n[warn] ${diagnostic.message}\n</harness>` },
      ],
    });
    expect(result.requests).toBe(2);
  });
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

  it("continues native sampling after a confirmed missing-directory Tool result", async () => {
    const unavailable = vi.fn();
    const { value } = configuration({
      onToolOperationUnavailable: unavailable,
      publishToolCommand: async (command) => ({
        operationId: command.request.operationId,
        accepted: true,
      }),
      waitForToolReply: async (request) => ({
        type: "tool_execution_end",
        toolCallId: (request as { toolCallId: string }).toolCallId,
        toolName: request.toolName,
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: "tool_root_unavailable: Selected working directory does not exist. This Tool did not run.",
            },
          ],
        },
      }),
    });
    const result = await runNativeRemote(createTrustedRemoteAgentTools(value));
    expect(result.requests).toBe(2);
    expect(unavailable).not.toHaveBeenCalled();
    expect(result.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("tool_root_unavailable") }],
    });
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  it.each([
    "reply timed out",
    "reply Worker stopped",
    "image decode failed",
    "reply identity mismatch",
    "structured failure",
    "unavailable before admission",
  ])("stops native Agent sampling after transport rejection: %s", async (reason) => {
    const expectedCode =
      reason === "structured failure"
        ? "ownership_lost"
        : reason === "unavailable before admission"
          ? "cubesandbox_tool_unavailable"
          : "tool_operation_outcome_unknown";
    const cause = ["structured failure", "unavailable before admission"].includes(reason)
      ? new ToolExecutionFailure({
          code: expectedCode,
          message: "Executor no longer owns this operation",
          effect: reason === "unavailable before admission" ? "not_started" : "unknown",
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
        code: expectedCode,
        effect: reason === "unavailable before admission" ? "not_started" : "unknown",
        retryable: false,
      }),
    );
    expect(result.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(expectedCode),
        },
      ],
    });
  });
});
