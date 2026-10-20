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
    maximumDepth: 3,
    control,
    nativeConversations: {
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
    prepareEnvironment: async () => {
      throw Error("Delegation must not activate Cube");
    },
  });
  const tool = bindings.find((b) => b.tool.name === "subagent")!.tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:4", nativeToolCallId: "call" }, () =>
    tool.prepareExecution!("call", { action: "run", task: "Check code", context: "branch" }),
  );
  expect(prepared.command).toMatchObject({
    target: "control",
    toolCallId: "task:4",
    nativeCallId: "call",
    conversationId: 1,
    contextAnchor: 3,
    arguments: { action: "run", task: "Check code" },
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
    prepareEnvironment: async () => "binding",
    prepareWorkflow: async () => {
      throw Error("No script");
    },
  });
  const tool = bindings.find((b) => b.tool.name === "preview")!.tool as PreparedAgentTool;
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
    prepareEnvironment: async () => "unused",
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
  const tool = bindings.find((b) => b.tool.name === "subagent")!.tool as PreparedAgentTool;
  for (const id of ["task:4", "task:5"]) {
    await withToolInvocation({ id, nativeToolCallId: "same-provider-id" }, () =>
      tool.prepareExecution!("same-provider-id", { action: "workflow", script: "return 1" }),
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
    prepareEnvironment = vi.fn(async () => "binding");
  const bindings = await f.runtime.create({
    command: { ...command, payload: { ...command.payload, sessionKind: "subagent" } },
    prepareEnvironment,
    prepareWorkflow: async () => {
      throw Error("No script");
    },
  });
  expect(bindings.find((b) => b.tool.name === "subagent")!.offered).toBe(false);
  expect(bindings.find((b) => b.tool.name === "contact_supervisor")!.offered).toBe(true);
  expect(prepareEnvironment).not.toHaveBeenCalled();
  const preview = bindings.find((b) => b.tool.name === "preview")!.tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:6", nativeToolCallId: "preview" }, () =>
    preview.prepareExecution!("preview", { port: 3000 }),
  );
  expect(prepared.command).toMatchObject({ bindingId: "binding", toolName: "preview" });
  expect(prepareEnvironment).toHaveBeenCalledOnce();
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
    prepareEnvironment: async () => "unused",
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
  const tool = bindings.find((b) => b.tool.name === "subagent")!.tool as PreparedAgentTool;
  const prepared = await withToolInvocation({ id: "task:13", nativeToolCallId: "workflow" }, () =>
    tool.prepareExecution!("workflow", { action: "workflow", script: "return 1" }),
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
