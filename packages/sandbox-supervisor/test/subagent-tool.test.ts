import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import {
  createCloudSubagentTool,
  validateSubagentTask,
  type CloudSubagentToolRuntime,
} from "../src/subagent-tool.ts";
import { SubagentControlClient } from "../src/subagent-control-client.ts";
import { MAX_SUBAGENT_RESULT_BYTES, type CandidateSubagentCommand } from "@pi-cloud/protocol";

function runtime(): CloudSubagentToolRuntime {
  return {
    run: vi.fn(async () => ({ executionId: "child", state: "completed", output: "child result" })),
    control: vi.fn(async () => ({ state: "accepted" })),
    workflow: vi.fn(async () => ({ selected: "only B", score: 7 })),
  };
}
describe("role-free log-driven Subagent Tool", () => {
  it.each(["x".repeat(100_001), "汉".repeat(100_000), "\u0001".repeat(50_000)])(
    "rejects oversized task text before delegation and in workflow validation",
    async (task) => {
      const backend = runtime(),
        tool = createCloudSubagentTool(backend);
      expect(() => tool.prepareArguments!({ action: "run", task })).toThrow();
      expect(() => validateSubagentTask({ key: "task", task })).toThrow();
      await expect(tool.execute("invalid", { action: "run", task })).rejects.toThrow();
      expect(backend.run).not.toHaveBeenCalled();
    },
  );
  it.each(["workflow", "run", "status"] as const)(
    "rejects an oversized %s result without repeating the action",
    async (action) => {
      const backend = runtime();
      const result = { state: "completed", output: "x".repeat(1024 * 1024) };
      const call = vi.fn(async () => result);
      backend.workflow = call;
      backend.run = call;
      backend.control = call;
      const args =
        action === "workflow"
          ? { action, script: "return 1" }
          : action === "run"
            ? { action, task: "inspect" }
            : { action, target: "child" };
      await expect(createCloudSubagentTool(backend).execute("call", args)).rejects.toThrow(
        "subagent_result_too_large",
      );
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves a largest accepted workflow text exactly", async () => {
    const backend = runtime();
    const text = "x".repeat(MAX_SUBAGENT_RESULT_BYTES - 2);
    backend.workflow = vi.fn(async () => text);
    await expect(
      createCloudSubagentTool(backend).execute("call", {
        action: "workflow",
        script: "return text",
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text }],
      details: { action: "workflow" },
    });
  });
  it("delegates without evaluating scripts or creating local sessions", async () => {
    const backend = runtime(),
      tool = createCloudSubagentTool(backend),
      signal = new AbortController().signal;
    const result = await tool.execute(
      "call",
      {
        action: "run",
        task: "inspect",
        context: "branch",
        sandbox: "ephemeral",
        cwd: "/workspace/worktrees/feature-a",
      },
      signal,
    );
    expect(backend.run).toHaveBeenCalledWith(
      "call",
      {
        key: "task",
        task: "inspect",
        context: "branch",
        sandbox: "ephemeral",
        cwd: "/workspace/worktrees/feature-a",
      },
      signal,
    );
    expect(backend.workflow).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ executionId: "child", state: "completed", output: "child result" }),
      },
    ]);
  });
  it("preserves the script-selected structured result, not concatenated child outputs", async () => {
    const backend = runtime(),
      tool = createCloudSubagentTool(backend);
    const source = "throw new Error('must never execute in this process')";
    const result = await tool.execute("call", { action: "workflow", script: source });
    expect(backend.workflow).toHaveBeenCalledWith("call", source, undefined);
    expect(result.content).toEqual([{ type: "text", text: '{"selected":"only B","score":7}' }]);
  });
  it("rejects retired persona/CLI/workflowScript parameters through its Pi schema", () => {
    const tool = createCloudSubagentTool(runtime());
    expect(Value.Check(tool.parameters, { agent: "researcher", task: "inspect" })).toBe(false);
    expect(Value.Check(tool.parameters, { workflowScript: "return 1" })).toBe(false);
    expect(
      Value.Check(tool.parameters, { action: "run", task: "inspect", workspace: "isolated" }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, { action: "run", task: "inspect", sandbox: "isolated" }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, { action: "run", task: "inspect", cwd: "relative/path" }),
    ).toBe(false);
    expect(Value.Check(tool.parameters, { action: "run", task: "inspect", context: "fork" })).toBe(
      false,
    );
    expect(
      Value.Check(tool.parameters, {
        action: "run",
        task: "inspect",
        context: "fresh",
        sandbox: "shared",
      }),
    ).toBe(true);
  });
  it("passes cancellation to the execution adapter and exposes failures as tool errors", async () => {
    const backend = runtime(),
      controller = new AbortController();
    backend.run = vi.fn(async (_id, _task, signal) => {
      signal?.throwIfAborted();
      throw new Error("child failed");
    });
    controller.abort(new Error("cancelled"));
    await expect(
      createCloudSubagentTool(backend).execute(
        "call",
        { action: "run", task: "inspect" },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
});

describe("Subagent control result correlation", () => {
  it("waits for Kafka ACK even if the result notification arrives first", async () => {
    let ack!: () => void, command!: CandidateSubagentCommand;
    const client = new SubagentControlClient(() => ({
      publishSubagentCommand: async (c) => {
        command = c;
        client.receive(c.executionReference, {
          requestId: c.requestId,
          ok: true,
          result: { state: "completed" },
        });
        await new Promise<void>((resolve) => {
          ack = resolve;
        });
      },
    }));
    let finished = false;
    const result = client
      .request({
        executionReference: "lease",
        toolCallId: "tool",
        workflowId: "workflow",
        request: { action: "status", target: "child" },
      })
      .then((value) => {
        finished = true;
        return value;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(command.request.action).toBe("status");
    ack();
    await expect(result).resolves.toEqual({ state: "completed" });
    client.close();
  });
  it("rejects a wrong authority and tolerates duplicate result delivery", async () => {
    let command!: CandidateSubagentCommand;
    const client = new SubagentControlClient(() => ({
      publishSubagentCommand: async (c) => {
        command = c;
      },
    }));
    const result = client.request({
      executionReference: "lease",
      toolCallId: "tool",
      workflowId: "workflow",
      request: { action: "wait", target: "child" },
    });
    await Promise.resolve();
    const response = { requestId: command.requestId, ok: true, result: { output: "done" } };
    expect(() => client.receive("other", response)).toThrow("authority");
    client.receive("lease", response);
    await expect(result).resolves.toEqual({ output: "done" });
    client.receive("lease", response);
    client.close();
  });
  it("releases aborted waiters and refuses requests after the host stops", async () => {
    const client = new SubagentControlClient(() => ({ publishSubagentCommand: async () => {} }));
    const controller = new AbortController();
    const result = client.request({
      executionReference: "lease",
      toolCallId: "tool",
      workflowId: "workflow",
      request: { action: "wait", target: "child" },
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toThrow("interrupted");
    client.close();
    await expect(
      client.request({
        executionReference: "lease",
        toolCallId: "tool",
        workflowId: "workflow",
        request: { action: "wait", target: "child" },
      }),
    ).rejects.toThrow("closed");
  });
});
