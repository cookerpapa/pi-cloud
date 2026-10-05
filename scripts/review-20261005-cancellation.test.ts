// Characterize a confirmed no-effect reply during Stop through the actual mailbox.
import { expect, it, vi } from "vitest";
import { ToolReplyMailbox } from "../packages/event-log/src/tool-replies.ts";
import { CubeCompletionAdapter } from "../packages/cube-completion/src/adapter.ts";
import { awaitCancelledToolReply } from "../packages/sandbox-supervisor/src/tool-cancellation.ts";
import { TOOL_CANCELLATION_UNKNOWN } from "@pi-cloud/protocol";

it("characterizes cancelled-before-start becoming UNKNOWN despite a structured no-effect reply", async () => {
  const mailbox = new ToolReplyMailbox(),
    waiter = new AbortController(),
    stopped = new AbortController();
  const unconfirmed = vi.fn(),
    reply = mailbox.wait("op", "call", "read", waiter.signal);
  const result = awaitCancelledToolReply({
    reply,
    signal: stopped.signal,
    received: () => false,
    cancel: async () => {},
    abortWait: (e) => waiter.abort(e),
    unconfirmed,
    timeoutMs: 1000,
  }).catch((e) => e);
  stopped.abort();
  const adapter = new CubeCompletionAdapter({
    publish: async (_topic, value) => mailbox.accept(value),
    progress: { update() {}, forget() {} },
  });
  await adapter.accept({
    kind: "result",
    operationId: "op",
    context: {
      scope: {
        tenantId: "tenant",
        sessionId: "session",
        piSessionId: "physical",
        runId: "run",
        turnId: "turn",
        writerId: "writer",
        leaseId: "writer",
        fencingToken: 1,
      },
      replyTopic: "reply",
      toolCallId: "entry",
      nativeToolCallId: "call",
      toolName: "read",
      partition: 0,
    },
    result: { failure: "tool_cancelled" },
  });
  expect((await result).message).toBe(TOOL_CANCELLATION_UNKNOWN);
  expect((await result).cause).toMatchObject({ code: "tool_cancelled", effect: "not_started" });
  expect(unconfirmed).toHaveBeenCalledOnce();
  mailbox.close();
});
