import { expect, it } from "vitest";
import { ToolReplyMailbox, parseWorkerReply, type ToolReply } from "../src/tool-replies.ts";
import {
  ToolExecutionFailure,
  type NativeToolEnd,
  type NativeToolUpdate,
} from "@pi-cloud/protocol";

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

it("requires a typed envelope and carries infrastructure failure separately from native text", async () => {
  expect(() =>
    parseWorkerReply(JSON.stringify({ operationId: "op", sequence: 1, event: end })),
  ).toThrow();
  expect(() =>
    parseWorkerReply(
      JSON.stringify({
        kind: "tool_result",
        operationId: "op",
        sequence: 1,
        event: end,
        failure: { code: "ownership_lost" },
      }),
    ),
  ).toThrow();
  const mailbox = new ToolReplyMailbox();
  const pending = mailbox.wait("op", "call_1", "bash", new AbortController().signal);
  mailbox.accept(
    parseWorkerReply(
      JSON.stringify({
        kind: "execution_failure",
        operationId: "op",
        sequence: 1,
        toolCallId: "call_1",
        toolName: "bash",
        failure: { code: "ownership_lost", message: "No confirmed result", effect: "unknown" },
      }),
    ),
  );
  await expect(pending).rejects.toBeInstanceOf(ToolExecutionFailure);
  await expect(pending).rejects.toMatchObject({ code: "ownership_lost", effect: "unknown" });
  const ordinary = mailbox.wait("text", "call_1", "bash", new AbortController().signal);
  const event = {
    ...end,
    isError: true,
    result: { content: [{ type: "text", text: "ownership_lost: application error" }] },
  };
  mailbox.accept(
    parseWorkerReply(
      JSON.stringify({ kind: "tool_result", operationId: "text", sequence: 1, event }),
    ),
  );
  await expect(ordinary).resolves.toEqual(event);
});

it("delivers one final result only to its registered operation, ignoring duplicates", async () => {
  const mailbox = new ToolReplyMailbox();
  const a = mailbox.wait("a", "call_1", "bash", new AbortController().signal);
  const b = mailbox.wait("b", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ kind: "tool_result", operationId: "a", sequence: 1, event: end });
  mailbox.accept({ kind: "tool_result", operationId: "a", sequence: 1, event: end });
  expect(await a).toEqual(end);
  expect(mailbox.size).toBe(1);
  mailbox.accept({ kind: "tool_result", operationId: "b", sequence: 1, event: end });
  expect(await b).toEqual(end);
  expect(mailbox.size).toBe(0);
});

it("keeps batched probe replies separate from native Tool promises and discards retired bindings", async () => {
  const mailbox = new ToolReplyMailbox(),
    cancel = new AbortController();
  const a = mailbox.waitProbe("probe", "a", cancel.signal),
    b = mailbox.waitProbe("probe", "b", new AbortController().signal);
  const tool = mailbox.wait("probe", "call_1", "bash", new AbortController().signal);
  cancel.abort(new Error("binding retired"));
  const reply = parseWorkerReply(
    JSON.stringify({
      kind: "execution_probe",
      probeId: "probe",
      sentAt: 100000,
      guestBootId: "guest",
      bindingIds: ["a", "b"],
      evidence: { bindingId: "a", targetId: "target", bootId: "boot", observedAt: 100001 },
    }),
  );
  mailbox.accept(reply);
  await expect(a).rejects.toThrow("retired");
  await expect(b).resolves.toMatchObject({ kind: "execution_probe" });
  expect(mailbox.size).toBe(1);
  mailbox.accept({ kind: "tool_result", operationId: "probe", sequence: 1, event: end });
  await expect(tool).resolves.toEqual(end);
  mailbox.close();
});

it("rejects progress on the final-only Kafka reply transport", async () => {
  const mailbox = new ToolReplyMailbox();
  const pending = mailbox.wait("op", "call_1", "bash", new AbortController().signal);
  mailbox.accept({
    kind: "tool_result",
    operationId: "op",
    sequence: 1,
    event: update,
  } as unknown as ToolReply);
  await expect(pending).rejects.toThrow("identity/order");
  expect(mailbox.size).toBe(0);
});

it("accepts a fast reply before the caller awaits its promise", async () => {
  const mailbox = new ToolReplyMailbox();
  const pending = mailbox.wait("op", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ kind: "tool_result", operationId: "op", sequence: 1, event: end });
  await expect(pending).resolves.toEqual(end);
});

it("never resurrects an aborted invocation from late results", async () => {
  const mailbox = new ToolReplyMailbox(),
    controller = new AbortController();
  const pending = mailbox.wait("op", "call_1", "bash", controller.signal);
  controller.abort(new Error("cancelled"));
  mailbox.accept({ kind: "tool_result", operationId: "op", sequence: 1, event: end });
  await expect(pending).rejects.toThrow("cancelled");
  expect(mailbox.size).toBe(0);
  const next = mailbox.wait("next-op", "call_1", "bash", new AbortController().signal);
  mailbox.accept({ kind: "tool_result", operationId: "op", sequence: 1, event: end });
  expect(mailbox.size).toBe(1);
  mailbox.accept({ kind: "tool_result", operationId: "next-op", sequence: 1, event: end });
  await expect(next).resolves.toEqual(end);
});

it("rejects identity and sequence changes without passing a partial success to Pi", async () => {
  const mailbox = new ToolReplyMailbox();
  const wrong = mailbox.wait("wrong", "different", "bash", new AbortController().signal);
  mailbox.accept({ kind: "tool_result", operationId: "wrong", sequence: 1, event: end });
  await expect(wrong).rejects.toThrow("identity/order");
  const gap = mailbox.wait("gap", "call_1", "bash", new AbortController().signal);
  mailbox.accept({
    kind: "tool_result",
    operationId: "gap",
    sequence: 2,
    event: end,
  } as unknown as ToolReply);
  await expect(gap).rejects.toThrow("identity/order");
});

it("closing one worker does not hand abandoned replies to another worker", async () => {
  const a = new ToolReplyMailbox(),
    b = new ToolReplyMailbox();
  const old = a.wait("old", "call_1", "bash", new AbortController().signal);
  a.close();
  b.accept({ kind: "tool_result", operationId: "old", sequence: 1, event: end });
  await expect(old).rejects.toThrow("UNKNOWN");
  expect(b.size).toBe(0);
});
