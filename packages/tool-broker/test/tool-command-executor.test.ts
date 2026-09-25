import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AcceptedToolCommand,
  type NativeToolEvent,
  type NativeToolUpdate,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { ToolCommandExecutor } from "../src/tool-command-executor.ts";
const instances: ToolCommandExecutor[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});
function command(): AcceptedToolCommand {
  const toolCallId = crypto.randomUUID();
  return {
    kind: "tool_command",
    factId: crypto.randomUUID(),
    toolCallId,
    replyTopic: "pi-cloud.tool-replies.v1.test",
    scope: {
      tenantId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      fencingToken: 1,
      piSessionId: crypto.randomUUID(),
      writerId: crypto.randomUUID(),
    },
    request: {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "c".repeat(64),
      toolName: "bash",
      operation: "tool.execute",
      toolCallId,
      args: { command: "echo once" },
      timeoutMs: 1000,
      maximumOutputBytes: 51200,
    },
    occurredAt: new Date().toISOString(),
  };
}
const record = <T>(fact: T, offset = 0n) => ({ fact, topic: "test", partition: 0, offset });
function output(request: AcceptedToolCommand["request"]): ToolSandboxOperationResponse {
  if (request.operation !== "tool.execute") throw new Error("Expected native Tool");
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: "tool.execute",
    event: {
      type: "tool_execution_end",
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      result: { content: [{ type: "text", text: "finished" }], details: undefined },
      isError: false,
    },
  };
}
function fixture(maximumActiveCommands = 32) {
  const bindings = new Set<string>();
  const execute = vi.fn(
    async (
      _lease: string,
      request: AcceptedToolCommand["request"],
      _signal?: AbortSignal,
      _update?: (event: NativeToolUpdate) => Promise<void>,
    ) => output(request),
  );
  const publish = vi.fn(
    async (
      _topic: string,
      _reply: { operationId: string; sequence: number; event: NativeToolEvent },
    ) => {},
  );
  const progress = vi.fn(),
    forget = vi.fn();
  const executor = new ToolCommandExecutor({
    maximumActiveCommands,
    broker: { execute, ownsToolBinding: (id) => bindings.has(id) },
    publishReply: publish,
    progress: { update: progress, forget },
  });
  instances.push(executor);
  return {
    executor,
    execute,
    publish,
    progress,
    forget,
    bindings,
    own: (c: AcceptedToolCommand) => bindings.add(c.request.activationId),
    settled: () =>
      vi.waitFor(() => expect(executor.statistics().activeCommands).toBe(0), { interval: 1 }),
  };
}
describe("native Kafka Tool replies without completed-result retention", () => {
  it("sends observations outside Kafka and publishes only the native final result", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    f.execute.mockImplementationOnce(async (_lease, request, _signal, update) => {
      await update!({
        type: "tool_execution_update",
        toolCallId: c.toolCallId,
        toolName: "bash",
        args: {},
        partialResult: { content: [{ type: "text", text: "working" }], details: undefined },
      });
      return output(request);
    });
    f.executor.receive(record(c));
    await f.settled();
    expect(
      f.publish.mock.calls.map(([, reply]) => [
        reply.operationId,
        reply.sequence,
        reply.event.type,
      ]),
    ).toEqual([[c.request.operationId, 1, "tool_execution_end"]]);
    expect(f.progress).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: c.scope.tenantId,
        partition: 0,
        progress: expect.objectContaining({ toolCallId: c.toolCallId, text: "working" }),
      }),
    );
    expect(f.forget).toHaveBeenCalledWith(c.request.operationId);
  });
  it("ignores duplicate delivery and delayed lower offsets after a seal", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    f.executor.receive(record(c, 10n));
    f.executor.receive(record(c, 10n));
    f.executor.receive(record({ kind: "execution_seal", scope: c.scope }, 12n));
    f.executor.receive(
      record({ ...c, request: { ...c.request, operationId: crypto.randomUUID() } }, 11n),
    );
    await f.settled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not publish a running command's late result after a seal", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    let finish!: (response: ToolSandboxOperationResponse) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.executor.receive(record(c));
    f.executor.receive(record({ kind: "execution_seal", scope: c.scope }, 1n));
    finish(output(c.request));
    await f.settled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("a writer seal closes siblings but not an unrelated Session", async () => {
    const f = fixture(),
      a = command(),
      b = command(),
      raw = command();
    const sibling = { ...raw, scope: { ...raw.scope, writerId: a.scope.writerId } };
    for (const c of [a, b, sibling]) f.own(c);
    f.executor.receive(record({ kind: "execution_seal", scope: a.scope, closesWriter: true }));
    f.executor.receive(record(sibling, 1n));
    f.executor.receive(record(b, 2n));
    await f.settled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0]![1].operationId).toBe(b.request.operationId);
  });
  it("bounds active execution and returns capacity errors without starting another effect", async () => {
    const f = fixture(1),
      a = command(),
      b = command();
    f.own(a);
    f.own(b);
    let finish!: (response: ToolSandboxOperationResponse) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.executor.receive(record(a));
    f.executor.receive(record(b, 1n));
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    expect(f.publish.mock.calls[0]![1].event).toMatchObject({
      isError: true,
      result: { content: [{ text: expect.stringContaining("capacity") }] },
    });
    expect(f.execute).toHaveBeenCalledOnce();
    finish(output(a.request));
    await f.settled();
  });
  it("never treats a Kafka reply failure as a dead Cube or retries the command", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    f.publish.mockRejectedValueOnce(new Error("Kafka unavailable"));
    f.execute.mockImplementationOnce(async (_lease, request, _signal, update) => {
      await update!({
        type: "tool_execution_update",
        toolCallId: c.toolCallId,
        toolName: "bash",
        args: {},
        partialResult: { content: [], details: undefined },
      });
      return output(request);
    });
    f.executor.receive(record(c));
    await f.settled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(() => f.executor.checkHealth()).not.toThrow();
    // A destination's failed reply must not permanently disable the Broker or
    // prevent another invocation from using a recovered producer.
    const next = command();
    f.own(next);
    f.executor.receive(record(next, 1n));
    await f.settled();
    expect(f.publish).toHaveBeenCalledTimes(2);
  });
  it("does not retain completed result bodies across a long Run", async () => {
    const f = fixture(),
      first = command();
    f.own(first);
    for (let i = 0; i < 100; i++) {
      const c = { ...first, request: { ...first.request, operationId: crypto.randomUUID() } };
      f.executor.receive(record(c, BigInt(i)));
      await f.settled();
    }
    expect(f.executor.statistics()).toEqual({
      acceptedCommands: 100,
      activeCommands: 0,
      maximumActiveCommands: 32,
    });
  });
  it("does not execute another owner's bindings or accept commands after shutdown", async () => {
    const f = fixture(),
      c = command();
    f.executor.receive(record(c));
    expect(f.execute).not.toHaveBeenCalled();
    await f.executor.close();
    expect(() => f.executor.receive(record(c, 1n))).toThrow("stopped");
  });
});
