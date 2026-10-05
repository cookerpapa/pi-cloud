import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createExecutionReference, type NativeToolEnd } from "@pi-cloud/protocol";
import { executeNativeTool } from "../../tool-sandbox/src/native-tools.ts";
import { createTrustedRemoteAgentTools } from "../src/trusted-remote-tools.ts";
import { withToolInvocation } from "../src/tool-invocation.ts";

it.each([
  "ordinary_error",
  "ownership_lost",
  "stale_session_lease",
  "cubesandbox_tool_unavailable",
  "cubesandbox_tool_result_unknown",
])("keeps ordinary Bash output starting with %s out of infrastructure control", async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-error-")),
    pending = Promise.withResolvers<NativeToolEnd>();
  const unavailable = vi.fn();
  const turn = "a".repeat(64),
    execution = "b".repeat(64);
  const runtime = createTrustedRemoteAgentTools({
    workingDirectory: cwd,
    workflowUrl: "http://127.0.0.1:1/workflow",
    activationId: randomUUID(),
    executionReference: createExecutionReference(randomUUID(), randomUUID(), 1),
    turnContextSha256: turn,
    executionContextSha256: execution,
    remainingToolCalls: null,
    maximumToolOutputBytes: 4096,
    onToolOperationUnavailable: unavailable,
    trackWorkflowOperation: () => {},
    waitForToolReply: async () => pending.promise,
    publishToolCommand: async (c) => ({ operationId: c.request.operationId, accepted: true }),
    captureStepContext: (activeTools) => {
      const context = {
        schemaVersion: 2 as const,
        sequence: 1,
        turnContextSha256: turn,
        executionContextSha256: execution,
        activeTools: [...activeTools].sort(),
        worldState: {
          sandbox: { status: "inactive" as const, continuitySha256: null },
          environmentSha256: "c".repeat(64),
          workspaceBindingSha256: "d".repeat(64),
          toolPolicySha256: "e".repeat(64),
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
    },
  });
  try {
    await runtime.transformContext([]);
    const tool = runtime.tools.find((t) => t.name === "bash")!;
    await withToolInvocation({ id: randomUUID(), nativeToolCallId: "review" }, async () => {
      const prepared = await tool.prepareExecution!("review", {
        command: `printf '${prefix}: ordinary application log\\n'; exit 7`,
      });
      try {
        if (prepared.command.request.operation !== "tool.execute") throw Error("wrong tool");
        const event = await executeNativeTool(
          prepared.command.request,
          cwd,
          new AbortController().signal,
          () => {},
        );
        expect(event.isError).toBe(true);
        pending.resolve(event);
        await expect(prepared.result()).resolves.toMatchObject({
          isError: true,
          content: [{ type: "text", text: expect.stringContaining("ordinary application log") }],
        });
        expect(unavailable).not.toHaveBeenCalled();
      } finally {
        prepared.dispose();
      }
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
