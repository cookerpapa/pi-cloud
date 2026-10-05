// Review characterization, outside the product test suite: compare both Tool paths.
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import {
  createExecutionReference,
  ToolExecutionFailure,
  type NativeToolEnd,
} from "@pi-cloud/protocol";
import { createTrustedRemoteAgentTools } from "../packages/sandbox-supervisor/src/trusted-remote-tools.ts";
import { withToolInvocation } from "../packages/sandbox-supervisor/src/tool-invocation.ts";

it.each(["workflow", "fixed"] as const)(
  "characterizes UNKNOWN handling in %s execution",
  async (kind) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No fixture address");
    const pending = Promise.withResolvers<NativeToolEnd>();
    const failure = new ToolExecutionFailure({
      code: "tool_operation_outcome_unknown",
      effect: "unknown",
      message: "Review lost executor",
    });
    const unavailable = vi.fn();
    server.on("connection", () => pending.reject(failure));
    const runtime = createTrustedRemoteAgentTools({
      publishToolCommand: async (command) => {
        if (kind === "fixed") pending.reject(failure);
        return { operationId: command.request.operationId, accepted: true };
      },
      publishToolCancellation: async () => {},
      waitForToolReply: async () => pending.promise,
      workflowUrl: `http://127.0.0.1:${address.port}/v1/tool-operations`,
      activationId: "10000000-0000-4000-8000-000000000001",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000010",
        "10000000-0000-4000-8000-000000000011",
        1,
      ),
      turnContextSha256: "b".repeat(64),
      executionContextSha256: "e".repeat(64),
      captureStepContext: (activeTools) => ({
        step: {
          sha256: "a".repeat(64),
          context: {
            schemaVersion: 2,
            sequence: 1,
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
      }),
      onToolOperationUnavailable: unavailable,
      remainingToolCalls: null,
      maximumToolOutputBytes: 65536,
      workingDirectory: "/workspace",
    });
    try {
      await runtime.transformContext([]);
      const result = withToolInvocation(
        { id: "invocation-review", nativeToolCallId: "review" },
        async () => {
          if (kind === "workflow")
            return runtime.executeWorkflow("review", "return 1", async () => null);
          const tool = runtime.tools.find((t) => t.name === "bash")!;
          const prepared = await tool.prepareExecution!("review", { command: "true" });
          try {
            pending.reject(failure);
            return await prepared.result();
          } finally {
            prepared.dispose();
          }
        },
      );
      await expect(result).rejects.toBe(failure);
      expect(unavailable).toHaveBeenCalledTimes(kind === "fixed" ? 1 : 0);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
