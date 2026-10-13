import { ToolReplyMailbox } from "@pi-cloud/event-log";
import {
  controlToolDefinitions,
  prepareSubagentArguments,
  validateSubagentTask,
  type ToolResultPayload,
  type CandidateControlToolCommand,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SubagentControlClient } from "../src/subagent-control-client.ts";

it.each(["x".repeat(100001), "汉".repeat(100000), "\u0001".repeat(50000)])(
  "rejects oversized delegation input before native intent",
  (task) => {
    expect(() => prepareSubagentArguments({ action: "run", task })).toThrow();
    expect(() => validateSubagentTask({ key: "one", task })).toThrow();
  },
);
it("keeps the role-free public tool schema and rejects retired invocation forms", () => {
  const schema = controlToolDefinitions().find((tool) => tool.name === "subagent")!.parameters;
  for (const args of [
    { agent: "researcher", task: "inspect" },
    { workflowScript: "return 1" },
    { action: "run", task: "inspect", workspace: "isolated" },
    { action: "run", task: "inspect", sandbox: "isolated" },
    { action: "run", task: "inspect", cwd: "relative/path" },
    { action: "run", task: "inspect", context: "fork" },
  ])
    expect(Value.Check(schema, args)).toBe(false);
  expect(
    Value.Check(schema, { action: "run", task: "inspect", context: "fresh", sandbox: "shared" }),
  ).toBe(true);
});

function mailboxFixture() {
  const mailbox = new ToolReplyMailbox();
  const transport = {
    topic: "pi-cloud.tool-replies.v3.fixture",
    wait: async (...args: Parameters<ToolReplyMailbox["wait"]>) =>
      (await mailbox.wait(...args)) as ToolResultPayload,
  };
  const reply = (
    command: CandidateControlToolCommand,
    value: Record<string, unknown>,
    authority = command.executionReference,
  ) =>
    mailbox.accept({
      kind: "tool_result",
      operationId: command.operationId,
      sequence: 1,
      result: {
        toolName: "subagent-control",
        toolCallId: command.toolCallId,
        isError: false,
        result: { content: [], details: { executionReference: authority, value } },
      },
    });
  return { mailbox, transport, reply };
}

describe("Subagent control result correlation through the shared Kafka mailbox", () => {
  it("waits for publication ACK even if the Kafka reply arrives first", async () => {
    const f = mailboxFixture();
    let ack!: () => void, command!: CandidateControlToolCommand;
    const client = new SubagentControlClient(
      {
        publishHostCall: async (_task, c) => {
          command = c;
          f.reply(c, { state: "completed" });
          await new Promise<void>((resolve) => {
            ack = resolve;
          });
        },
        retireHostCall: async () => {},
      },
      f.transport,
    );
    let finished = false;
    const result = client
      .request({
        executionReference: "lease",
        conversationId: 1,
        toolCallId: "task:4",
        request: { action: "status", target: "child" },
      })
      .then((value) => {
        finished = true;
        return value;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(command.replyMode).toBe("hostcall");
    ack();
    await expect(result).resolves.toEqual({ state: "completed" });
    client.close();
    f.mailbox.close();
  });
  it("rejects wrong authority and ignores duplicate completed replies", async () => {
    const f = mailboxFixture();
    let command!: CandidateControlToolCommand;
    const client = new SubagentControlClient(
      {
        publishHostCall: async (_task, c) => {
          command = c;
        },
        retireHostCall: async () => {},
      },
      f.transport,
    );
    const request = {
      executionReference: "lease",
      conversationId: 1,
      toolCallId: "task:4",
      request: { action: "wait" as const, target: "child" },
    };
    const bad = client.request(request);
    await Promise.resolve();
    f.reply(command, { output: "wrong" }, "other");
    await expect(bad).rejects.toThrow("authority");
    const result = client.request(request);
    await Promise.resolve();
    f.reply(command, { output: "done" });
    await expect(result).resolves.toEqual({ output: "done" });
    f.reply(command, { output: "done" });
    expect(f.mailbox.size).toBe(0);
    client.close();
    f.mailbox.close();
  });
  it("retires aborted hostcall waiters and rejects use after host shutdown", async () => {
    const f = mailboxFixture();
    const client = new SubagentControlClient(
      {
        publishHostCall: async () => {},
        retireHostCall: async () => {},
      },
      f.transport,
    );
    const controller = new AbortController();
    const request = {
      executionReference: "lease",
      conversationId: 1,
      toolCallId: "task:4",
      request: { action: "wait" as const, target: "child" },
    };
    const result = client.request({ ...request, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("interrupted");
    expect(f.mailbox.size).toBe(0);
    client.close();
    await expect(client.request(request)).rejects.toThrow("closed");
    f.mailbox.close();
  });
});
