import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxToolCall,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";
import {
  createExecutionReference,
  ToolExecutionFailure,
  type NativeToolEnd,
  type CandidateToolCommand,
} from "@pi-cloud/protocol";
import { createTrustedRemoteAgentTools } from "../src/trusted-remote-tools.ts";
import { withToolInvocation } from "../src/tool-invocation.ts";

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
    const publish = vi.fn(async (command: CandidateToolCommand) => ({
      operationId: command.request.operationId,
      accepted: true as const,
    }));
    const remote = createTrustedRemoteAgentTools({
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
    const provider = fauxProvider({ tokensPerSecond: 1000000 }),
      models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("workflow", { script: "return 1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const scoped = new ScopedDurableModels(models, async (request) => {
      const input = request.input as import("@earendil-works/pi-ai").Context;
      const messages = await remote.transformContext(input.messages);
      return {
        model: provider.getModel(),
        options: request.options,
        input: { ...input, messages },
        release: () => {},
      };
    });
    const model = scoped.register(crypto.randomUUID(), 1, provider.getModel());
    const tool: ToolRegistration = {
      name: "workflow",
      description: "fixture",
      parameters: Type.Object({ script: Type.String() }),
      execute: async (args, api, context) =>
        withToolInvocation({ id: `task:${api.taskId}`, nativeToolCallId: api.callId }, async () => {
          const prepared = await remote.prepareWorkflow(
            api.callId,
            (args as { script: string }).script,
            async () => null,
            context.abortSignal,
            "workflow",
          );
          try {
            if (!("request" in prepared.command)) throw Error("Expected workflow transport");
            await publish(prepared.command);
            return await prepared.result();
          } finally {
            prepared.dispose();
          }
        }),
    };
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixture", tools: [tool] }));
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: scoped.models,
        registry,
        settings: { retry: { maxRetries: 0 }, compaction: { enabled: false } },
      },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.configure({ model, tools: [tool] }, BACKGROUND_CONTEXT);
    try {
      await (
        await root.submit({ type: "input", content: "Execute once" }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);
      expect(provider.state.callCount).toBe(blocks ? 1 : 2);
      expect(publish).toHaveBeenCalledOnce();
      expect(unavailable).toHaveBeenCalledTimes(blocks ? 1 : 0);
      const result = (await root.context(BACKGROUND_CONTEXT)).messages.find(
        (message) => message.role === "toolResult",
      );
      expect(result).toMatchObject({ toolName: "workflow", isError: kind !== "success" });
      if (kind === "business-error")
        expect(JSON.stringify(result)).toContain("ordinary script exception");
      if (kind === "not-started") expect(JSON.stringify(result)).toContain("tool_cancelled");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
