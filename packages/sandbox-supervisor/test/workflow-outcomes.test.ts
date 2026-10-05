import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createExecutionReference,
  ToolExecutionFailure,
  type NativeToolEnd,
} from "@pi-cloud/protocol";
import { createTrustedRemoteAgentTools } from "../src/trusted-remote-tools.ts";
import { withToolInvocation } from "../src/tool-invocation.ts";

const model: Model<"openai-responses"> = {
  id: "gpt-6-luna",
  name: "Scripted workflow fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it.each([
  ["success", false],
  ["business-error", false],
  ["not-started", false],
  ["executor-unavailable", true],
  ["unknown", true],
  ["socket-lost", true],
  ["bad-frame", true],
] as const)(
  "applies the Workflow outcome to the actual next Pi sampling boundary: %s",
  async (kind, blocks) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing fixture address");
    const reply = Promise.withResolvers<NativeToolEnd>();
    let failure: Error | undefined;
    const unavailable = vi.fn((error: { code: string; message: string }) => {
      failure = new Error(error.code);
    });
    server.on("connection", (socket) => {
      if (kind === "socket-lost") {
        socket.terminate();
        return;
      }
      if (kind === "bad-frame") {
        socket.send("not JSON");
        return;
      }
      if (["not-started", "executor-unavailable", "unknown"].includes(kind)) {
        reply.reject(
          new ToolExecutionFailure({
            code:
              kind === "not-started"
                ? "tool_cancelled"
                : kind === "executor-unavailable"
                  ? "cubesandbox_tool_unavailable"
                  : "tool_operation_outcome_unknown",
            effect: kind === "unknown" ? "unknown" : "not_started",
            message: "Fixture infrastructure outcome",
          }),
        );
        return;
      }
      reply.resolve({
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "bash",
        isError: kind === "business-error",
        result: {
          content: [{ type: "text", text: "ownership_lost: ordinary script exception" }],
          details: 42,
        },
      });
    });
    let step = 0;
    const publish = vi.fn(
      async (
        command: Parameters<
          Parameters<typeof createTrustedRemoteAgentTools>[0]["publishToolCommand"]
        >[0],
      ) => ({ operationId: command.request.operationId, accepted: true as const }),
    );
    const remote = createTrustedRemoteAgentTools({
      publishToolCommand: publish,
      publishToolCancellation: async () => {},
      waitForToolReply: async (_request, signal) => {
        signal.addEventListener("abort", () => reply.reject(signal.reason), { once: true });
        return reply.promise;
      },
      workflowUrl: `http://127.0.0.1:${address.port}/v1/tool-operations`,
      activationId: "10000000-0000-4000-8000-000000000001",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000010",
        "10000000-0000-4000-8000-000000000011",
        1,
      ),
      turnContextSha256: "b".repeat(64),
      executionContextSha256: "e".repeat(64),
      captureStepContext: (activeTools) => {
        if (failure) throw failure;
        return {
          step: {
            sha256: "a".repeat(64),
            context: {
              schemaVersion: 2,
              sequence: ++step,
              turnContextSha256: "b".repeat(64),
              executionContextSha256: "e".repeat(64),
              activeTools: [...activeTools],
              worldState: {
                sandbox: { status: "inactive", continuitySha256: null },
                environmentSha256: "c".repeat(64),
                workspaceBindingSha256: "f".repeat(64),
                toolPolicySha256: "d".repeat(64),
              },
            },
          },
          modelMessages: [],
          samplingAttempt: 1,
        };
      },
      onToolOperationUnavailable: unavailable,
      remainingToolCalls: null,
      maximumToolOutputBytes: 65536,
      workingDirectory: "/workspace",
    });
    let requests = 0;
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: "fixture",
        tools: [
          {
            name: "workflow",
            label: "workflow",
            description: "fixture",
            parameters: Type.Object({ script: Type.String() }),
            execute: async (id, args, signal) =>
              withToolInvocation({ id: `invocation-${id}`, nativeToolCallId: id }, async () => {
                const value = await remote.executeWorkflow(
                  id,
                  (args as { script: string }).script,
                  async () => null,
                  signal,
                );
                return {
                  content: [{ type: "text" as const, text: String(value) }],
                  details: undefined,
                };
              }),
          },
        ],
      },
      transformContext: (messages, signal) => {
        signal?.throwIfAborted();
        return remote.transformContext(messages);
      },
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
                  id: "call",
                  name: "workflow",
                  arguments: { script: "return 1" },
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
          () => message,
        );
        queueMicrotask(() =>
          stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    });
    try {
      await agent.prompt("Execute once");
      expect(requests).toBe(blocks ? 1 : 2);
      expect(publish).toHaveBeenCalledOnce();
      expect(unavailable).toHaveBeenCalledTimes(blocks ? 1 : 0);
      const result = agent.state.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ toolName: "workflow", isError: kind !== "success" });
      if (kind === "business-error")
        expect(JSON.stringify(result)).toContain("ordinary script exception");
      if (kind === "not-started") expect(JSON.stringify(result)).toContain("tool_cancelled");
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
