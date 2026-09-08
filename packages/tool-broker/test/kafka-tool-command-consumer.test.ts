import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionLease,
  type AcceptedToolCommand,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
const transport = vi.hoisted(() => ({ options: [] as any[] }));
vi.mock("@pi-cloud/event-log", () => ({
  KafkaLogConsumer: class {
    constructor(options: unknown) {
      transport.options.push(options);
    }
    async captureEndOffsets() {
      return [0n];
    }
    async start() {}
    async waitUntilInitialReplay() {}
    checkHealth() {}
    async close() {}
  },
}));
import { KafkaToolCommandConsumer } from "../src/kafka-tool-command-consumer.ts";

const instances: KafkaToolCommandConsumer[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  vi.useRealTimers();
});
function command(): AcceptedToolCommand {
  return {
    kind: "tool_command",
    factId: crypto.randomUUID(),
    toolCallId: crypto.randomUUID(),
    scope: {
      tenantId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      fencingToken: 1,
    },
    request: {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      turnContextSha256: "a".repeat(64),
      attemptContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "c".repeat(64),
      toolName: "bash",
      operation: "bash.exec",
      command: "echo once",
      cwd: "/workspace",
      timeoutMs: 1000,
    },
    occurredAt: new Date().toISOString(),
  };
}
const lease = (c: AcceptedToolCommand) =>
  createExecutionLease(c.scope.leaseId, c.scope.attemptId, c.scope.fencingToken);
const record = <T extends { kind: string; scope: { attemptId: string } }>(
  fact: T,
  offset = 0n,
) => ({ fact, topic: "test", partition: 0, offset });
const output = (c: AcceptedToolCommand): ToolSandboxOperationResponse => ({
  toolBrokerProtocolVersion: 1,
  type: "tool_sandbox.operation_result",
  activationId: c.request.activationId,
  operationId: c.request.operationId,
  operation: "bash.exec",
  exitCode: 0,
  outputChunks: [],
  outputSha256: "d".repeat(64),
});
function fixture(maximumResultBytes?: number) {
  const bindings = new Map<string, string>();
  const execute = vi.fn(async (_lease: string, request: AcceptedToolCommand["request"]) =>
    output({ ...command(), request }),
  );
  const consumer = new KafkaToolCommandConsumer({
    brokers: ["unused:9092"],
    topic: "test",
    ...(maximumResultBytes === undefined ? {} : { maximumResultBytes }),
    broker: {
      execute,
      ownsToolBinding: (id) => bindings.has(id),
      assertToolResultReader: (id, expected) => {
        if (bindings.get(id) !== expected) throw new Error("stale binding");
      },
    },
  });
  instances.push(consumer);
  const own = (c: AcceptedToolCommand) => bindings.set(c.request.activationId, lease(c));
  return { consumer, own, execute, bindings };
}

function receipt(c: AcceptedToolCommand) {
  return {
    kind: "pi_session_mutation",
    scope: c.scope,
    events: [{ type: "tool.completed", payload: { toolCallId: c.toolCallId } }],
    operation: {
      kind: "append_items",
      items: [
        {
          kind: "append_entry",
          entry: {
            type: "message",
            message: { role: "toolResult", toolCallId: c.toolCallId },
          },
        },
      ],
    },
  };
}

describe("Kafka-driven Tool command execution", () => {
  it("uses a native result as delivery ACK, releasing all operations but preserving dedup", async () => {
    const f = fixture(),
      a = command();
    const b = { ...a, request: { ...a.request, operationId: crypto.randomUUID() } };
    f.own(a);
    for (const c of [a, b]) {
      await f.consumer.consume(record(c));
      await f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId);
    }
    expect(f.consumer.statistics().retainedResults).toBe(2);
    expect(f.consumer.statistics().retainedResultBytes).toBeGreaterThan(0);
    // A UI event and another execution's same tool ID are not acknowledgements.
    await f.consumer.consume(record({ kind: "agent_event", scope: a.scope }));
    for (const field of ["tenantId", "sessionId", "runId", "turnId", "attemptId"] as const) {
      const other = { ...receipt(a), scope: { ...a.scope, [field]: crypto.randomUUID() } };
      await f.consumer.consume(record(other));
    }
    expect(f.consumer.statistics().retainedResults).toBe(2);
    await f.consumer.consume(record(receipt(a)));
    await f.consumer.consume(record(receipt(a))); // duplicate receipt is harmless
    expect(f.consumer.statistics()).toMatchObject({
      retainedResults: 0,
      retainedResultBytes: 0,
      releasedResults: 2,
    });
    for (const c of [a, b]) {
      await f.consumer.consume(record(c));
      await expect(
        f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId),
      ).rejects.toMatchObject({ code: "tool_result_released" });
    }
    expect(f.execute).toHaveBeenCalledTimes(2);
    await expect(f.consumer.consume(record({ ...a, toolCallId: "different" }))).rejects.toThrow(
      "different arguments",
    );
  });

  it("does not resurrect results when an UNKNOWN receipt arrives before a running effect finishes", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    let finish!: (result: ToolSandboxOperationResponse) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.consumer.consume(record(c));
    const reader = f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId);
    await f.consumer.consume(record(receipt(c)));
    finish(output(c));
    expect(await reader).toMatchObject({ exitCode: 0 });
    expect(f.consumer.statistics()).toMatchObject({ retainedResults: 0, retainedResultBytes: 0 });
    await f.consumer.consume(record(c));
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("seals release missing-result bodies and never affect another active lane", async () => {
    const f = fixture(),
      a = command(),
      b = { ...command(), toolCallId: a.toolCallId };
    for (const c of [a, b]) {
      f.own(c);
      await f.consumer.consume(record(c));
      await f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId);
    }
    await f.consumer.consume(record({ kind: "execution_seal", scope: a.scope }));
    expect(f.consumer.statistics().retainedResults).toBe(1);
    await expect(
      f.consumer.waitResult(lease(a), a.request.activationId, a.request.operationId),
    ).rejects.toMatchObject({ code: "tool_command_sealed" });
    await f.consumer.consume(record(receipt(a)));
    expect(f.consumer.statistics().retainedResults).toBe(1);
    await f.consumer.consume(record(receipt(b)));
    expect(f.consumer.statistics().retainedResults).toBe(0);
  });

  it("bounds retry-body bytes without re-executing an evicted operation", async () => {
    const c = command();
    const bytes = Buffer.byteLength(JSON.stringify(output(c)));
    const f = fixture(bytes + 1),
      b = command();
    for (const value of [c, b]) {
      f.own(value);
      await f.consumer.consume(record(value));
      await f.consumer.waitResult(
        lease(value),
        value.request.activationId,
        value.request.operationId,
      );
    }
    expect(f.consumer.statistics()).toMatchObject({ retainedResults: 1, releasedResults: 1 });
    expect(f.consumer.statistics().retainedResultBytes).toBeLessThanOrEqual(bytes + 1);
    await f.consumer.consume(record(c));
    await expect(
      f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId),
    ).rejects.toMatchObject({ code: "tool_result_released" });
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.consumer.consume(record(receipt(b)));
    expect(f.consumer.statistics().retainedResultBytes).toBe(0);
  });

  it("a long Run releases each tool body before its eventual execution seal", async () => {
    const f = fixture(),
      first = command();
    f.own(first);
    for (let i = 0; i < 500; i++) {
      const c = {
        ...first,
        toolCallId: `call-${i}`,
        request: { ...first.request, operationId: crypto.randomUUID() },
      };
      await f.consumer.consume(record(c));
      await f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId);
      await f.consumer.consume(record(receipt(c)));
      expect(f.consumer.statistics().retainedResultBytes).toBe(0);
    }
    expect(f.consumer.statistics()).toMatchObject({ releasedResults: 500, retainedResults: 0 });
    expect(f.execute).toHaveBeenCalledTimes(500);
  });
  it("a result read never starts a command; only consuming its log record does", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    const result = f.consumer.waitResult(lease(c), c.request.activationId, c.request.operationId);
    expect(f.execute).not.toHaveBeenCalled();
    await f.consumer.consume(record(c));
    expect(await result).toMatchObject({ exitCode: 0 });
    await f.consumer.consume(record(c, 1n));
    expect(f.execute).toHaveBeenCalledOnce();
    await expect(
      f.consumer.waitResult("wrong", c.request.activationId, c.request.operationId),
    ).rejects.toThrow("stale binding");
  });
  it("long Tool execution does not block another Session or hide an execution seal", async () => {
    const f = fixture(),
      a = command(),
      b = command();
    f.own(a);
    f.own(b);
    let finish!: (value: ToolSandboxOperationResponse) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.consumer.consume(record(a));
    const result = f.consumer.waitResult(lease(a), a.request.activationId, a.request.operationId);
    await f.consumer.consume(record(b, 1n));
    expect(
      await f.consumer.waitResult(lease(b), b.request.activationId, b.request.operationId),
    ).toMatchObject({ exitCode: 0 });
    await f.consumer.consume(record({ kind: "execution_seal", scope: a.scope }, 2n));
    const late = { ...a, request: { ...a.request, operationId: crypto.randomUUID() } };
    await f.consumer.consume(record(late, 3n));
    await expect(
      f.consumer.waitResult(lease(a), late.request.activationId, late.request.operationId),
    ).rejects.toMatchObject({ code: "tool_command_sealed" });
    expect(f.execute).toHaveBeenCalledTimes(2);
    finish(output(a));
    await result; // a started effect may still finish; no automatic replay.
  });
  it("ignores another Broker's bindings and fails a reader after its binding disappears", async () => {
    const f = fixture(),
      c = command();
    await f.consumer.consume(record(c));
    expect(f.execute).not.toHaveBeenCalled();
    f.own(c);
    vi.useFakeTimers();
    const result = f.consumer
      .waitResult(lease(c), c.request.activationId, c.request.operationId)
      .catch((error) => error);
    f.bindings.clear();
    // Timer was registered before fake timers, so close is the explicit wake here.
    await f.consumer.close();
    expect(await result).toBeInstanceOf(Error);
  });
  it("keeps the first boot floor on reconnect, but a new boot starts at a new floor", async () => {
    const f = fixture(),
      options = transport.options.at(-1);
    const bounds = (high: bigint) => [{ partition: 0, low: 0n, high }];
    expect((await options.replayOffsets(bounds(10n))).get(0)).toBe(10n);
    expect((await options.replayOffsets(bounds(20n))).get(0)).toBe(10n);
    await f.consumer.consume(record({ kind: "ignored", scope: { attemptId: "a" } }, 12n));
    expect((await options.replayOffsets(bounds(20n))).get(0)).toBe(13n);
    fixture();
    expect((await transport.options.at(-1).replayOffsets(bounds(20n))).get(0)).toBe(20n);
    expect(
      (await options.replayOffsets([{ partition: 0, low: 14n, high: 20n }])).get(0),
    ).toBeInstanceOf(Error);
  });
  it("rejects a reused command ID with different arguments", async () => {
    const f = fixture(),
      c = command();
    f.own(c);
    await f.consumer.consume(record(c));
    await expect(
      f.consumer.consume(record({ ...c, request: { ...c.request, command: "different" } }, 1n)),
    ).rejects.toThrow("different arguments");
    expect(f.execute).toHaveBeenCalledOnce();
  });
});
