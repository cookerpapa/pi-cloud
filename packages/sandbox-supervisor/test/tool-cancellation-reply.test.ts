// Actual completion adapter -> boot mailbox -> cancellation settlement contract.
import { expect, it, vi } from "vitest";
import { ToolReplyMailbox } from "../../event-log/src/tool-replies.ts";
import { CubeCompletionAdapter } from "../../cube-completion/src/adapter.ts";
import { awaitCancelledToolReply } from "../src/tool-cancellation.ts";
import { ToolExecutionFailure } from "@pi-cloud/protocol";

it.each(["before-stop", "after-stop"])(
  "keeps the confirmed no-effect reply through cancellation: %s",
  async (ordering) => {
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
    if (ordering === "after-stop") stopped.abort();
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
      result: { failure: "tool_cancelled_before_start" },
    });
    if (ordering === "before-stop") stopped.abort();
    expect(await result).toBeInstanceOf(ToolExecutionFailure);
    expect(await result).toMatchObject({
      code: "tool_cancelled_before_start",
      effect: "not_started",
    });
    expect((await result).message).toContain("did not start");
    expect(unconfirmed).not.toHaveBeenCalled();
    mailbox.close();
  },
);
