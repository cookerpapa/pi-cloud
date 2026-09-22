import { expect, it } from "vitest";
import { ToolReplyMailbox } from "../src/tool-replies.ts";
import type { NativeToolEnd, NativeToolUpdate } from "@pi-cloud/protocol";

const update: NativeToolUpdate = {
  type: "tool_execution_update",
  toolCallId: "call_1",
  toolName: "bash",
  args: { command: "test" },
  partialResult: { content: [{ type: "text", text: "progress" }], details: undefined },
};
const end: NativeToolEnd = {
  type: "tool_execution_end",
  toolCallId: "call_1",
  toolName: "bash",
  result: { content: [{ type: "text", text: "done" }], details: undefined },
  isError: false,
};

it("delivers native updates and completion only to their registered invocation", async () => {
  const mailbox = new ToolReplyMailbox(),
    seen: NativeToolUpdate[] = [];
  const a = mailbox.wait("a", "call_1", "bash", new AbortController().signal, (event) =>
    seen.push(event),
  );
  const b = mailbox.wait("b", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ operationId: "a", sequence: 1, event: update });
  mailbox.accept({ operationId: "a", sequence: 1, event: update });
  mailbox.accept({ operationId: "a", sequence: 2, event: end });
  mailbox.accept({ operationId: "a", sequence: 3, event: update });
  expect(await a).toEqual(end);
  expect(seen).toEqual([update]);
  expect(mailbox.size).toBe(1);
  mailbox.accept({ operationId: "b", sequence: 1, event: end });
  expect(await b).toEqual(end);
  expect(mailbox.size).toBe(0);
});

it("accepts a fast reply before the caller awaits its promise", async () => {
  const mailbox = new ToolReplyMailbox();
  const pending = mailbox.wait("op", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ operationId: "op", sequence: 1, event: end });
  await expect(pending).resolves.toEqual(end);
});

it("never resurrects an aborted invocation from late results", async () => {
  const mailbox = new ToolReplyMailbox(),
    controller = new AbortController();
  const pending = mailbox.wait("op", "call_1", "bash", controller.signal);
  controller.abort(new Error("cancelled"));
  mailbox.accept({ operationId: "op", sequence: 1, event: end });
  await expect(pending).rejects.toThrow("cancelled");
  expect(mailbox.size).toBe(0);
});

it("rejects identity and sequence changes without passing a partial success to Pi", async () => {
  const mailbox = new ToolReplyMailbox();
  const wrong = mailbox.wait("wrong", "different", "bash", new AbortController().signal);
  mailbox.accept({ operationId: "wrong", sequence: 1, event: end });
  await expect(wrong).rejects.toThrow("identity/order");
  const gap = mailbox.wait("gap", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ operationId: "gap", sequence: 2, event: end });
  await expect(gap).rejects.toThrow("identity/order");
});

it("closing one worker does not hand abandoned replies to another worker", async () => {
  const a = new ToolReplyMailbox(),
    b = new ToolReplyMailbox();
  const old = a.wait("old", "call_1", "bash", new AbortController().signal);
  a.close();
  b.accept({ operationId: "old", sequence: 1, event: end });
  await expect(old).rejects.toThrow("UNKNOWN");
  expect(b.size).toBe(0);
});
