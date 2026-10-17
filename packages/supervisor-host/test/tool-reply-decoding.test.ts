import { expect, it } from "vitest";
import { ToolReplyMailbox } from "@pi-cloud/event-log";
import { restoreToolReply } from "../src/tool-reply-result.ts";

it("preserves execution receipt but rejects a Stop delivered just before decoded return", async () => {
  const mailbox = new ToolReplyMailbox(),
    stopped = new AbortController();
  const wait = mailbox.wait("op", "call", "bash", stopped.signal);
  const result = restoreToolReply(wait, undefined, { tenantId: "tenant" }, stopped.signal);
  mailbox.accept({
    kind: "tool_result",
    operationId: "op",
    sequence: 1,
    result: {
      toolCallId: "call",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "complete" }] },
    },
  });
  queueMicrotask(() => stopped.abort(new Error("Stop before return")));
  await expect(result.result).rejects.toThrow("Stop before return");
  expect(result.executionSettled()).toBe(true);
  expect(mailbox.size).toBe(0);
});
