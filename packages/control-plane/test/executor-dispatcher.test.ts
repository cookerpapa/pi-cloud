import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { AcceptedExecutorToolCommand } from "@pi-cloud/protocol";
import { ExecutorTransportFailure, type ExecutorTransport } from "@pi-cloud/sandbox-control";
import { ExecutorDispatcher } from "../src/executor-dispatcher.ts";
import { ExecutionBindingView, type ExecutionBindingRow } from "../src/execution-target-service.ts";

function fixture() {
  const fact: AcceptedExecutorToolCommand = {
    kind: "executor_tool",
    target: "executor",
    operationId: randomUUID(),
    bindingId: randomUUID(),
    taskId: 12,
    conversationId: 1,
    toolName: "android_tap",
    replyTopic: "test-replies",
    nativeCallId: "call-12",
    arguments: { x: 20, y: 30 },
    operationIndex: 1,
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      piSessionId: randomUUID(),
      writerId: randomUUID(),
      fencingToken: 3,
    },
  };
  const row: ExecutionBindingRow = {
    id: fact.bindingId,
    tenant_id: fact.scope.tenantId,
    session_id: fact.scope.sessionId,
    run_id: fact.scope.runId,
    pi_session_id: fact.scope.piSessionId,
    writer_id: fact.scope.writerId,
    fencing_token: "3",
    conversation_id: "1",
    target_id: randomUUID(),
    target_revision: "1",
    admission_generation: "9",
    executor_boot_id: randomUUID(),
    endpoint: "http://owned-executor:8090",
    capabilities: ["android.touch"],
    closed: false,
    revision: "4",
  };
  const get = vi.fn((): ExecutionBindingRow | undefined => row);
  const routes = { get, closeWriter: vi.fn(async () => {}) } as unknown as ExecutionBindingView;
  const transport: ExecutorTransport = {
    inspect: vi.fn(),
    submit: vi.fn(async () => {}),
    revoke: vi.fn(),
    cancel: vi.fn(),
    screenshot: vi.fn(),
    close: vi.fn(),
  };
  const cube = { consume: vi.fn(async () => {}) },
    publish = vi.fn(async () => {});
  const dispatcher = new ExecutorDispatcher({ cube, routes, transport, publish });
  const record = { fact, topic: "session-log", partition: 2, offset: 120n };
  return { fact, row, get, transport, cube, publish, dispatcher, record };
}

describe("Android dispatch through the existing committed Session consumer", () => {
  it("uses only the binding view and retains the batch operation index", async () => {
    const f = fixture();
    await f.dispatcher.consume(f.record);
    expect(f.get).toHaveBeenCalledWith(f.fact.bindingId, f.fact.scope);
    expect(f.transport.submit).toHaveBeenCalledWith(
      f.row.endpoint,
      expect.objectContaining({
        arguments: { x: 20, y: 30 },
        position: { topic: "session-log", partition: 2, offset: "120", index: 1 },
        binding: expect.objectContaining({ generation: "9", writerId: f.fact.scope.writerId }),
      }),
    );
    expect(f.transport.inspect).not.toHaveBeenCalled();
    expect(f.cube.consume).not.toHaveBeenCalled();
  });
  it("cannot route a child through the root conversation's binding", async () => {
    const f = fixture();
    await f.dispatcher.consume({ ...f.record, fact: { ...f.fact, conversationId: 2 } });
    expect(f.transport.submit).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledWith(
      f.fact.replyTopic,
      expect.objectContaining({
        kind: "execution_failure",
        failure: expect.objectContaining({ effect: "not_started" }),
      }),
    );
  });
  it("does not retry an uncertain handoff and preserves its uncertainty", async () => {
    const f = fixture();
    vi.mocked(f.transport.submit).mockRejectedValue(
      new ExecutorTransportFailure({
        code: "executor_handoff_unconfirmed",
        effect: "unknown",
        message: "connection lost",
      }),
    );
    await f.dispatcher.consume(f.record);
    expect(f.transport.submit).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledWith(
      f.fact.replyTopic,
      expect.objectContaining({
        failure: expect.objectContaining({ effect: "unknown" }),
      }),
    );
  });
  it("does not hand off after losing partition ownership", async () => {
    const f = fixture();
    await f.dispatcher.consume(f.record, () => false);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.transport.submit).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
});
