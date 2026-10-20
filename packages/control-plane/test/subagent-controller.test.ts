import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import type { SubagentHostRequest } from "@pi-cloud/protocol";
import type { ControlToolOutcome } from "../src/control-tool-dispatcher.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

let f: Awaited<ReturnType<typeof nativeSubagentFixture>>;
const inputs: Extract<SubagentHostRequest, { action: "input" }>[] = [];
const receivedInputs = new Set<string>(),
  stopped = new Set<number>();
let host: SubagentController;
beforeAll(async () => {
  f = await nativeSubagentFixture();
  host = new SubagentController({
    database: f.database,
    managementToken: "x".repeat(48),
    allowInsecureHttp: true,
    deliver: async (_reference, request) => {
      if (request.action === "start_conversation") return f.native.start(request);
      if (request.action === "stop_conversation") {
        stopped.add(f.children.get(request.requestId)!.conversationId);
        return f.native.stop(request.executionReference, request.requestId);
      }
      if (receivedInputs.has(request.requestId)) return { accepted: true };
      if (stopped.has(request.conversationId)) return { accepted: false };
      inputs.push(request);
      receivedInputs.add(request.requestId);
      return { accepted: true };
    },
  });
}, 60_000);
afterAll(async () => {
  await host?.close();
  await f?.close();
});
function value(outcome: ControlToolOutcome) {
  if ("waiting" in outcome) throw new Error("Expected settled Tool");
  return JSON.parse(
    outcome.result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
}

it("starts and waits through one native invocation, with no start/wait command rows or child Run", async () => {
  const call = await f.command({ task: "Inspect code" });
  expect(await host.executeTool(call, () => true)).toEqual({ waiting: true });
  expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);
  const child = f.children.get(call.operationId)!;
  await f.settle(call.operationId);
  expect(value(await host.executeTool(call, () => true))).toMatchObject({
    executionId: call.operationId,
    childSessionId: child.request.view.sessionId,
    rootRunId: f.scope.runId,
    state: "completed",
    output: "Child answer",
  });
  expect(f.children.size).toBe(1);
});

it("returns the original delegation answer even after a separate later child answer", async () => {
  const call = await f.command({ task: "Original answer identity" });
  await host.executeTool(call, () => true);
  await f.settle(call.operationId, "completed", "ORIGINAL");
  const child = f.children.get(call.operationId)!;
  const entryId = f.allocateId();
  const answerId = f.allocateId();
  const submissionId = f.allocateId();
  await f.append(
    [
      {
        type: "entry",
        value: {
          id: entryId,
          conversationId: child.conversationId,
          kind: "pi.user",
          model: [{ role: "user", content: "Later input", timestamp: Date.now() }],
        },
      },
      {
        type: "entry",
        value: {
          id: answerId,
          conversationId: child.conversationId,
          kind: "pi.assistant",
          model: [fauxAssistantMessage("LATER")],
        },
      },
      {
        type: "submission",
        value: {
          id: submissionId,
          conversationId: child.conversationId,
          type: "input",
          requestId: "later-question",
          status: "done",
          entry: entryId,
          answer: answerId,
        },
      },
    ],
    child.request.view,
  );
  expect(value(await host.executeTool(call, () => true)).output).toBe("ORIGINAL");
  const wait = await f.command({ action: "wait", target: call.operationId });
  expect(value(await host.executeTool(wait, () => true)).output).toBe("LATER");
});

it("lists current-family children without a target, including completed children", async () => {
  const task = "Inspect the database";
  const call = await f.command({ task });
  await host.executeTool(call, () => true);
  await f.settle(call.operationId);
  for (let index = 0; index < 25; index++) {
    const next = await f.command({ task: `Paged child ${index}` });
    await host.executeTool(next, () => true);
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await f.command({ action: "list", ...(cursor ? { cursor } : {}) });
    const page = value(await host.executeTool(list, () => true));
    expect(page.agents.length).toBeLessThanOrEqual(24);
    for (const agent of page.agents) {
      ids.push(agent.executionId);
      if (agent.executionId === call.operationId) {
        expect(agent).toMatchObject({ task, state: "completed", sourceTaskId: call.taskId });
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids.length).toBe(new Set(ids).size);
  expect(new Set(ids)).toEqual(new Set(f.children.keys()));
});

it("unblocks the parent for supervisor interaction while the child remains a native task", async () => {
  const run = await f.command({ task: "Ask a question" });
  await host.executeTool(run, () => true);
  const child = f.children.get(run.operationId)!;
  const childView = { ...child.request.view, conversationId: child.conversationId };
  const contact = await f.command(
    { reason: "need_decision", message: "Which option?" },
    childView,
    "contact_supervisor",
  );
  expect(await host.executeTool(contact, () => true)).toHaveProperty("waiting", true);
  const blocked = value(await host.executeTool(run, () => true));
  expect(blocked.state).toBe("blocked");
  const reply = await f.command(
    { action: "reply", replyTo: blocked.supervisorRequest.requestId, message: "Choose A" },
    undefined,
    "subagent_supervisor",
  );
  expect(await host.executeTool(reply, () => true)).toEqual({ waiting: true });
  const answered = await host.executeTool(contact, () => true);
  expect(answered).toMatchObject({ result: { content: [{ type: "text", text: "Choose A" }] } });
  await f.finishCall(contact);
  await f.settle(run.operationId);
  expect(await host.executeTool(reply, () => true)).toMatchObject({
    result: { content: [{ type: "text", text: "Child answer" }] },
  });
});

it("addresses input and cancellation by Conversation under the current root grant", async () => {
  const run = await f.command({ task: "Receive a message" });
  await host.executeTool(run, () => true);
  const child = f.children.get(run.operationId)!;
  const send = await f.command({
    action: "send",
    target: run.operationId,
    message: "Extra context",
    delivery: "follow_up",
  });
  expect(value(await host.executeTool(send, () => true))).toMatchObject({
    state: "accepted",
    delivery: "follow_up",
  });
  expect(inputs.at(-1)).toMatchObject({
    executionReference: f.reference,
    runId: f.scope.runId,
    conversationId: child.conversationId,
    requestId: send.operationId,
  });
  const cancel = await f.command({ action: "cancel", target: run.operationId });
  expect(value(await host.executeTool(cancel, () => true)).state).toBe("cancelled");
  expect(value(await host.executeTool(send, () => true)).state).toBe("accepted");
  const late = await f.command({
    action: "send",
    target: run.operationId,
    message: "Too late",
    delivery: "follow_up",
  });
  expect(value(await host.executeTool(late, () => true)).state).toBe("missed");
  const root = await f.database
    .selectFrom("runs")
    .select("state")
    .where("id", "=", f.scope.runId)
    .executeTakeFirstOrThrow();
  expect(root.state).toBe("running");
});

it("keeps infrastructure uncertainty retryable but settles invalid targets and oversized results", async () => {
  const invalid = await f.command({ action: "status", target: "missing-child" });
  expect(await host.executeTool(invalid, () => true)).toMatchObject({ isError: true });
  const run = await f.command({ task: "Large response" });
  await host.executeTool(run, () => true);
  await f.settle(run.operationId, "completed", "x".repeat(300_000));
  expect(await host.executeTool(run, () => true)).toMatchObject({
    isError: true,
    result: {
      content: [{ type: "text", text: expect.stringContaining("subagent_result_too_large") }],
    },
  });
  const fail = new SubagentController({
    database: f.database,
    managementToken: "x".repeat(48),
    allowInsecureHttp: true,
    deliver: vi.fn(async () => {
      throw Object.assign(new Error("delivery unconfirmed"), { retryable: true });
    }),
  });
  try {
    const uncertain = await f.command({ task: "Retry delivery" });
    await expect(fail.executeTool(uncertain, () => true)).rejects.toThrow("delivery unconfirmed");
  } finally {
    await fail.close();
  }
});
