import { expect, it, vi } from "vitest";
import { WorkerToolRuntime } from "../src/tools/worker-tool-runtime.ts";
import { ToolReplyMailbox } from "@pi-cloud/event-log";
import {
  withToolInvocation,
  type PreparedAgentTool,
  type WorkflowPreparer,
  type SubagentControlClient,
} from "@pi-cloud/sandbox-supervisor";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import { restoreToolReply } from "../src/tool-reply-result.ts";
import { ControlToolRegistry, previewToolDefinition } from "@pi-cloud/control-plane";

const command = {
  payload: {
    sessionKind: "conversation",
    tenantId: "tenant",
    sessionId: "session",
    runId: "run",
    executionReference: "grant",
    piSession: { conversationId: 1 },
  },
} as ExecuteTurnCommandMessage;

function fixture(codec?: ImageAttachmentCodec) {
  const mailbox = new ToolReplyMailbox();
  const control = {
    request: vi.fn<SubagentControlClient["request"]>(async (input) => {
      input.onPublished?.();
      return { state: "completed", executionId: input.toolCallId };
    }),
  };
  const runtime = new WorkerToolRuntime({
    implementation: () => ({ releaseId: "test-v1", generation: 1, replay: "never" }),
    catalog: (() => {
      const catalog = new ControlToolRegistry();
      catalog.register({
        definition: previewToolDefinition,
        async execute() {
          throw new Error("Worker cannot execute platform effects");
        },
      });
      return catalog;
    })(),
    maximumDepth: 3,
    control,
    nativeConversations: {
      originalControlIntent: async () => {
        throw new Error("No recovery source in this fixture");
      },
      childAnchor: async (_ref, inherit) => (inherit ? "3" : null),
      conversationDepth: async () => 3,
    },
    wait: (id, callId, name, signal, scope) =>
      restoreToolReply(mailbox.wait(id, callId, name, signal), codec, scope, signal),
  });
  return { runtime, mailbox, control };
}

it("prepares a control invocation and returns its reply without executing its business logic", async () => {
  const f = fixture();
  const bindings = await f.runtime.create({
    command,
    prepareWorkflow: async () => {
      throw Error("No script");
    },
    environment: () => {
      throw Error("Delegation must not activate Cube");
    },
  });
  const tool = bindings.current().find((b) => b.tool.name === "subagent")!
    .tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:4", nativeToolCallId: "call" }, () =>
    tool.prepareExecution!("call", { task: "Check code", context: "branch" }),
  );
  expect(prepared.command).toMatchObject({
    target: "control",
    toolCallId: "task:4",
    nativeCallId: "call",
    conversationId: 1,
    contextAnchor: 3,
    arguments: { task: "Check code" },
  });
  expect(f.control.request).not.toHaveBeenCalled();
  if (!("operationId" in prepared.command)) throw Error("Expected control command");
  f.mailbox.accept({
    kind: "tool_result",
    sequence: 1,
    operationId: prepared.command.operationId,
    result: {
      toolCallId: "call",
      toolName: "subagent",
      isError: false,
      result: { content: [{ type: "text", text: "DONE" }] },
    },
  });
  await expect(prepared.result()).resolves.toMatchObject({
    content: [{ type: "text", text: "DONE" }],
  });
  prepared.dispose();
  f.mailbox.close();
});

it("recovers a delegation with its original effect and a fresh callback identity", async () => {
  const f = fixture();
  const source = {
    sequence: 18,
    operationId: "original-child",
    taskId: 44,
    conversationId: 1,
    toolName: "subagent" as const,
    nativeCallId: "recover-call",
    arguments: { task: "Original task" },
    contextAnchor: 3,
  };
  vi.spyOn(f.runtime.options.nativeConversations, "originalControlIntent").mockResolvedValue(
    source,
  );
  const bindings = await f.runtime.create({
    command,
    environment: () => {
      throw new Error("No VM for delegation");
    },
    prepareWorkflow: async () => {
      throw new Error("No script replay");
    },
  });
  const tool = bindings.current().find((b) => b.tool.name === "subagent")!
    .tool as PreparedAgentTool;
  expect(tool.replay).toBe("safe");
  const recover = (args: unknown) =>
    withToolInvocation({ id: "task:44", nativeToolCallId: "recover-call" }, () =>
      tool.prepareRecovery!("recover-call", args),
    );
  await expect(recover({ task: "Changed task" })).rejects.toThrow("differs");
  expect(f.mailbox.size).toBe(0);
  const prepared = await recover(source.arguments);
  if (!("target" in prepared.command) || prepared.command.target !== "control")
    throw new Error("Expected control recovery");
  expect(prepared.command.operationId).not.toBe(source.operationId);
  expect(prepared.command).toMatchObject({
    recovery: { sequence: 18, operationId: "original-child" },
    contextAnchor: 3,
  });
  // Old delivery cannot satisfy the freshly registered wait.
  f.mailbox.accept({
    kind: "tool_result",
    operationId: source.operationId,
    sequence: 1,
    result: {
      toolName: "subagent",
      toolCallId: "recover-call",
      isError: false,
      result: { content: [{ type: "text", text: "stale" }] },
    },
  });
  expect(f.mailbox.size).toBe(1);
  f.mailbox.accept({
    kind: "tool_result",
    operationId: prepared.command.operationId,
    sequence: 1,
    result: {
      toolName: "subagent",
      toolCallId: "recover-call",
      isError: false,
      result: { content: [{ type: "text", text: "current" }] },
    },
  });
  expect(await prepared.result()).toMatchObject({ content: [{ text: "current" }] });
  prepared.dispose();
  f.mailbox.close();
});

it("retains a control Tool's receipt when restoring its image fails", async () => {
  const codec = new ImageAttachmentCodec({
    async put() {
      throw Error("Unexpected upload");
    },
    async get() {
      throw Error("Private object-store failure");
    },
  });
  const f = fixture(codec);
  const bindings = await f.runtime.create({
    command,
    environment: () =>
      ({ requestId: "binding" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
    prepareWorkflow: async () => {
      throw Error("No script");
    },
  });
  const tool = bindings.current().find((b) => b.tool.name === "preview")!.tool as PreparedAgentTool;
  const prepared = await withToolInvocation(
    { id: "task:7", nativeToolCallId: "image-preview" },
    () => tool.prepareExecution!("image-preview", { port: 3000 }),
  );
  try {
    if (!("operationId" in prepared.command)) throw Error("Expected control command");
    f.mailbox.accept({
      kind: "tool_result",
      sequence: 1,
      operationId: prepared.command.operationId,
      result: {
        toolCallId: "image-preview",
        toolName: "preview",
        isError: false,
        result: {
          content: [
            {
              type: "pi_cloud_image_v1",
              attachment: {
                id: "10000000-0000-4000-8000-000000000003",
                sha256: "a".repeat(64),
                byteLength: 1,
                mimeType: "image/png",
              },
            },
          ],
        },
      },
    });
    expect(prepared.completed()).toBe(true);
    await expect(prepared.result()).rejects.toMatchObject({
      code: "tool_result_attachment_unavailable",
    });
    expect(prepared.completed()).toBe(true);
  } finally {
    prepared.dispose();
    f.mailbox.close();
  }
});

it("publishes one dynamic run request for a workflow key and isolates reused provider call IDs", async () => {
  const f = fixture();
  let callback: Parameters<WorkflowPreparer>[2] | undefined;
  const bindings = await f.runtime.create({
    command,
    environment: () =>
      ({ requestId: "unused" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
    prepareWorkflow: async (_id, _script, call) => {
      callback = call;
      return {
        command: {} as never,
        completed: () => false,
        dispose() {},
        result: async () => ({}),
      };
    },
  });
  const tool = bindings.current().find((b) => b.tool.name === "workflow")!
    .tool as PreparedAgentTool;
  for (const id of ["task:4", "task:5"]) {
    await withToolInvocation({ id, nativeToolCallId: "same-provider-id" }, () =>
      tool.prepareExecution!("same-provider-id", { script: "return 1" }),
    );
    const args = { key: "one", task: { task: "Check code" } };
    expect(await callback!("run", args)).toEqual(await callback!("run", args));
    await expect(callback!("run", { key: "one", task: { task: "Changed" } })).rejects.toThrow(
      "changed arguments",
    );
  }
  expect(f.control.request).toHaveBeenCalledTimes(2);
  expect(
    f.control.request.mock.calls.map(([input]) => [input.toolCallId, input.request.action]),
  ).toEqual([
    ["task:4", "run"],
    ["task:5", "run"],
  ]);
  f.mailbox.close();
});

it("derives tool exposure from native ancestry and prepares environment only for preview", async () => {
  const f = fixture(),
    environment = vi.fn(
      () => ({ requestId: "binding" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
    );
  const bindings = await f.runtime.create({
    command: { ...command, payload: { ...command.payload, sessionKind: "subagent" } },
    environment,
    prepareWorkflow: async () => {
      throw Error("No script");
    },
  });
  expect(bindings.current().find((b) => b.tool.name === "subagent")!.offered).toBe(false);
  expect(bindings.current().find((b) => b.tool.name === "contact_supervisor")!.offered).toBe(true);
  expect(environment).not.toHaveBeenCalled();
  const preview = bindings.current().find((b) => b.tool.name === "preview")!
    .tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:6", nativeToolCallId: "preview" }, () =>
    preview.prepareExecution!("preview", { port: 3000 }),
  );
  expect(prepared.command).toMatchObject({ bindingId: "binding", toolName: "preview" });
  expect(environment).toHaveBeenCalledOnce();
  prepared.dispose();
  f.mailbox.close();
});

it("cancels outstanding workflow host calls and rejects late callbacks after disposal", async () => {
  const f = fixture();
  let callback: Parameters<WorkflowPreparer>[2] | undefined;
  f.control.request.mockImplementation(async (input) => {
    input.onPublished?.();
    return new Promise((_, reject) => {
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
    });
  });
  const bindings = await f.runtime.create({
    command,
    environment: () =>
      ({ requestId: "unused" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
    prepareWorkflow: async (_id, _script, call) => {
      callback = call;
      return {
        command: {} as never,
        completed: () => false,
        dispose() {},
        result: async () => ({}),
      };
    },
  });
  const tool = bindings.current().find((b) => b.tool.name === "workflow")!
    .tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:13", nativeToolCallId: "workflow" }, () =>
    tool.prepareExecution!("workflow", { script: "return 1" }),
  );
  const running = callback!("run", { key: "one", task: { task: "Pending child" } });
  void running.catch(() => {});
  await vi.waitFor(() => expect(f.control.request).toHaveBeenCalledOnce());
  prepared.dispose();
  await expect(running).rejects.toThrow("Workflow invocation has closed");
  await expect(callback!("run", { key: "two", task: { task: "Late child" } })).rejects.toThrow(
    "Workflow invocation has closed",
  );
  expect(f.control.request).toHaveBeenCalledOnce();
  f.mailbox.close();
});

it("offers phone capabilities only to the granted root and lazily prepares its own destination", async () => {
  const { androidToolDefinitions, ANDROID_CAPABILITIES } = await import("@pi-cloud/protocol");
  const { WorkerToolCatalog } = await import("../src/tools/worker-tool-catalog.ts");
  const { controlToolCatalog } = await import("@pi-cloud/control-plane");
  const catalog = new WorkerToolCatalog();
  catalog.update(controlToolCatalog(androidToolDefinitions()));
  const mailbox = new ToolReplyMailbox();
  const prepareTarget = vi.fn(async () => crypto.randomUUID());
  const runtime = new WorkerToolRuntime({
    implementation: () => ({ releaseId: "test-v1", generation: 1, replay: "never" }),
    catalog,
    prepareTarget,
    maximumDepth: null,
    control: {
      request: async () => {
        throw Error("Not a child command");
      },
    },
    nativeConversations: {
      originalControlIntent: async () => {
        throw Error("No replay");
      },
      childAnchor: async () => {
        throw Error("Phone Tools do not need native ancestry");
      },
      conversationDepth: async () => 0,
    },
    wait: (id, callId, name, signal, scope) =>
      restoreToolReply(mailbox.wait(id, callId, name, signal), undefined, scope, signal),
  });
  const granted = {
    ...command,
    payload: {
      ...command.payload,
      executionTargets: [
        {
          targetId: crypto.randomUUID(),
          revision: "1",
          name: "phone",
          kind: "android" as const,
          capabilities: [...ANDROID_CAPABILITIES],
        },
      ],
    },
  };
  const environment = vi.fn(() => {
    throw Error("Phone tools must not allocate Cube");
  });
  const context = {
    command: granted,
    environment,
    prepareWorkflow: async () => {
      throw Error("No workflow");
    },
  };
  const root = await runtime.create(context);
  expect(
    root
      .current()
      .filter((t) => t.offered && t.tool.name.startsWith("android_"))
      .map((t) => t.tool.name),
  ).toHaveLength(6);
  const child = await runtime.create({
    ...context,
    command: { ...granted, payload: { ...granted.payload, sessionKind: "subagent" } },
  });
  expect(
    child.current().filter((t) => t.offered && t.tool.name.startsWith("android_")).length,
  ).toBe(0);
  const bare = await runtime.create({ ...context, command });
  expect(bare.current().filter((t) => t.offered && t.tool.name.startsWith("android_")).length).toBe(
    0,
  );
  expect(prepareTarget).not.toHaveBeenCalled();
  const tool = root.current().find((t) => t.tool.name === "android_observe")!
    .tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:8", nativeToolCallId: "phone-call" }, () =>
    tool.prepareExecution!("phone-call", {}),
  );
  expect(prepared.command).toMatchObject({ target: "executor", toolName: "android_observe" });
  expect(prepareTarget).toHaveBeenCalledTimes(1);
  expect(environment).not.toHaveBeenCalled();
  if (!("operationId" in prepared.command)) throw Error("Wrong target");
  mailbox.accept({
    kind: "tool_result",
    sequence: 1,
    operationId: prepared.command.operationId,
    result: {
      toolName: "android_observe",
      toolCallId: "phone-call",
      isError: false,
      result: { content: [{ type: "text", text: "screen" }] },
    },
  });
  await expect(prepared.result()).resolves.toMatchObject({
    content: [{ type: "text", text: "screen" }],
  });
  prepared.dispose();
  const reply = {
    topic: `pi-cloud.tool-replies.v4.${crypto.randomUUID()}`,
    partition: 0 as const,
    offset: "17",
    deadlineAt: Date.now() + 18000,
    toolCallId: "phone-call",
    toolName: "android_observe",
  };
  const source: import("@pi-cloud/protocol").OriginalRemoteToolIntent = {
    sequence: 12,
    taskId: 8,
    conversationId: 1,
    reply,
    command: {
      kind: "executor_tool",
      target: "executor",
      operationId: crypto.randomUUID(),
      bindingId: "original-binding",
      taskId: 8,
      conversationId: 1,
      toolName: "android_observe",
      nativeCallId: "phone-call",
      arguments: {},
      occurredAt: new Date().toISOString(),
      scope: {
        tenantId: "tenant",
        runId: "run",
        sessionId: "session",
        turnId: "turn",
        piSessionId: "physical",
        writerId: "old-writer",
        fencingToken: 1,
      },
      replyTopic: reply.topic,
      replyRecovery: reply,
    },
  };
  const wait = vi.spyOn(runtime.options, "wait");
  const recovered = await withToolInvocation({ id: "task:8", nativeToolCallId: "phone-call" }, () =>
    tool.prepareRecovery!("phone-call", {}, undefined, source),
  );
  expect(tool.recoverySource).toBe("reply");
  expect(wait.mock.calls.at(-1)?.[5]).toBe(source.reply);
  expect(recovered.command).toMatchObject({
    operationId: (source.command as import("@pi-cloud/protocol").AcceptedExecutorToolCommand)
      .operationId,
    bindingId: "original-binding",
    originalWriterId: "old-writer",
  });
  expect(prepareTarget).toHaveBeenCalledTimes(1);
  mailbox.accept({
    kind: "tool_result",
    sequence: 1,
    operationId: (source.command as import("@pi-cloud/protocol").AcceptedExecutorToolCommand)
      .operationId,
    result: {
      toolName: "android_observe",
      toolCallId: "phone-call",
      isError: false,
      result: { content: [{ type: "text", text: "original" }] },
    },
  });
  expect(await recovered.result()).toMatchObject({ content: [{ text: "original" }] });
  recovered.dispose();
  catalog.update(controlToolCatalog([]));
  expect(root.current().some((t) => t.tool.name === "android_observe")).toBe(false);
  await expect(
    withToolInvocation({ id: "task:9", nativeToolCallId: "old-call" }, () =>
      tool.prepareExecution!("old-call", {}),
    ),
  ).rejects.toThrow("withdrawn");
  mailbox.close();
});

it("withholds every workspace Tool from a workspace-null child and rejects stale invocation", async () => {
  const f = fixture();
  f.runtime.options.maximumDepth = null;
  const environment = vi.fn(
    () =>
      ({ requestId: "must-not-be-created" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
  );
  const prepareWorkflow = vi.fn(async () => {
    throw Error("must-not-run");
  });
  const bindings = await f.runtime.create({
    command: {
      ...command,
      payload: { ...command.payload, sessionKind: "subagent", toolCapabilities: [] },
    },
    environment,
    prepareWorkflow,
  });
  expect(bindings.current().find((b) => b.tool.name === "preview")?.offered).toBe(false);
  expect(bindings.current().find((b) => b.tool.name === "workflow")?.offered).toBe(false);
  expect(bindings.current().find((b) => b.tool.name === "subagent")?.offered).toBe(true);
  const preview = bindings.current().find((b) => b.tool.name === "preview")!
    .tool as PreparedAgentTool;
  await expect(
    withToolInvocation({ id: "task:4", nativeToolCallId: "stale" }, () =>
      preview.prepareExecution!("stale", { port: 8080 }),
    ),
  ).rejects.toThrow("workspace_unavailable");
  const catalog = f.runtime.options.catalog as ControlToolRegistry;
  catalog.register({
    definition: { ...previewToolDefinition, name: "late_workspace_tool" },
    execute: async () => ({ result: { content: [] } }),
  });
  expect(bindings.current().find((b) => b.tool.name === "late_workspace_tool")?.offered).toBe(
    false,
  );
  expect(environment).not.toHaveBeenCalled();
  expect(prepareWorkflow).not.toHaveBeenCalled();
  f.mailbox.close();
});

it("refreshes root-only catalog tools without treating native Conversation 1 as an authority", async () => {
  const f = fixture();
  const prepare = {
    environment: () => {
      throw Error("No Workspace is needed");
    },
    prepareWorkflow: async () => {
      throw Error("No workflow is needed");
    },
  };
  const root = await f.runtime.create({
    ...prepare,
    command: {
      ...command,
      payload: {
        ...command.payload,
        piSession: { ...command.payload.piSession, conversationId: 17 },
      },
    },
  });
  const child = await f.runtime.create({
    ...prepare,
    command: {
      ...command,
      payload: { ...command.payload, sessionKind: "subagent", toolCapabilities: [] },
    },
  });
  const withdraw = (f.runtime.options.catalog as ControlToolRegistry).register({
    definition: {
      name: "root_management",
      description: "Test root-only management",
      environment: { kind: "none" },
      availability: "root",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async () => ({ result: { content: [] } }),
  });
  expect(root.current().find((b) => b.tool.name === "root_management")?.offered).toBe(true);
  const binding = child.current().find((b) => b.tool.name === "root_management")!;
  expect(binding.offered).toBe(false);
  await expect(
    withToolInvocation({ id: "task:9", nativeToolCallId: "stale-root-tool" }, () =>
      (binding.tool as PreparedAgentTool).prepareExecution!("stale-root-tool", {}),
    ),
  ).rejects.toThrow("root conversation");
  withdraw();
  expect(root.current().some((b) => b.tool.name === "root_management")).toBe(false);
  f.mailbox.close();
});

it("resolves Skill activation from the frozen manifest and only prepares a Workspace for execution files", async () => {
  const f = fixture();
  const catalog = f.runtime.options.catalog as ControlToolRegistry;
  catalog.register({
    definition: {
      name: "skill",
      description: "Read Skills",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          name: { type: "string" },
          versionId: { type: "string" },
          path: { type: "string" },
        },
      },
      environment: { kind: "skill" },
    },
    execute: async () => {
      throw Error("No Worker business execution");
    },
  });
  const text = {
    versionId: "text",
    packageId: "pack",
    name: "text",
    description: "Text",
    digest: "a".repeat(64),
    requirements: { runtime: "none" as const, tools: [], software: [] },
    runtimeMetadata: { disableModelInvocation: false, requiresWorkspaceFiles: false },
  };
  const script = {
    ...text,
    versionId: "script",
    name: "script",
    runtimeMetadata: { ...text.runtimeMetadata, requiresWorkspaceFiles: true },
  };
  const prepare = vi.fn(
    () => ({ requestId: "binding" }) as import("@pi-cloud/protocol").ToolEnvironmentRequest,
  );
  const bindings = await f.runtime.create({
    command: { ...command, payload: { ...command.payload, skillCatalog: [text, script] } },
    prepareWorkflow: async () => {
      throw Error("No workflow");
    },
    environment: prepare,
  });
  const tool = bindings.current().find((t) => t.tool.name === "skill")!.tool as PreparedAgentTool;
  try {
    for (const [n, args] of [
      { action: "read", name: "text" },
      { action: "read", name: "script", path: "references/a.md" },
      { action: "read", name: "script" },
    ].entries()) {
      const prepared = await withToolInvocation(
        { id: `task:${n + 10}`, nativeToolCallId: `call-${n}` },
        () => tool.prepareExecution!(`call-${n}`, args),
      );
      if (n < 2) expect(prepare).not.toHaveBeenCalled();
      else expect(prepare).toHaveBeenCalledOnce();
      expect(prepared.command).toMatchObject({ target: "control", arguments: args });
      prepared.dispose();
    }
    await expect(
      withToolInvocation({ id: "task:20", nativeToolCallId: "unknown" }, () =>
        tool.prepareExecution!("unknown", { action: "read", versionId: "unselected" }),
      ),
    ).rejects.toThrow("not selected");
  } finally {
    f.mailbox.close();
  }
});
