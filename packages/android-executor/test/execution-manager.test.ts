import { encodeSessionImages } from "@pi-cloud/session-attachments";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ANDROID_CAPABILITIES, type ExecutorOperation } from "@pi-cloud/protocol";
import { toolReplyTopic } from "@pi-cloud/event-log";
import { AndroidExecutionManager } from "../src/execution-manager.ts";
import { AndroidToolError } from "../src/appium-driver.ts";
import { createExecutorServer } from "../src/server.ts";
function fixture() {
  const targetId = randomUUID(),
    bootId = randomUUID();
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  const publish = vi.fn(async () => {});
  const manager = new AndroidExecutionManager({
    targetId,
    bootId,
    execute,
    pack: async (binding, result) =>
      encodeSessionImages(undefined, { tenantId: binding.tenantId }, result),
    publish,
  });
  const command: ExecutorOperation = {
    version: 1,
    binding: {
      bindingId: randomUUID(),
      targetId,
      bootId,
      generation: "1",
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      writerId: randomUUID(),
      piSessionId: randomUUID(),
      fencingToken: 1,
      capabilities: [...ANDROID_CAPABILITIES],
    },
    position: { topic: "session", partition: 0, offset: "120", index: 0 },
    operationId: randomUUID(),
    toolName: "android_tap",
    nativeCallId: "call",
    arguments: { x: 2, y: 3 },
    replyTopic: toolReplyTopic(randomUUID()),
  };
  return { manager, command, execute, publish };
}
async function settled(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.manager.busy).toBe(false));
}
describe("Android external effect boundary", () => {
  it("retries only immutable Kafka replies, never the UI action", async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    f.manager.submit(f.command);
    await settled(f);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[0]).toEqual(f.publish.mock.calls[1]);
    expect(() => f.manager.submit(f.command)).toThrow("executor_position_stale");
    await f.manager.close();
  });
  it("uses the tool index within a shared Kafka offset", async () => {
    const f = fixture();
    f.manager.submit(f.command);
    await settled(f);
    f.manager.submit({
      ...f.command,
      operationId: randomUUID(),
      position: { ...f.command.position, index: 1 },
    });
    await settled(f);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.manager.close();
  });
  it("closes admission even before the first tool and never reopens it", async () => {
    const f = fixture();
    f.manager.closeBinding(f.command.binding);
    expect(() => f.manager.submit(f.command)).toThrow("executor_binding_closed");
    const next = {
      ...f.command,
      binding: { ...f.command.binding, bindingId: randomUUID(), generation: "2" },
    };
    f.manager.submit(next);
    await settled(f);
    expect(() => f.manager.submit(f.command)).toThrow("executor_binding_stale");
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.manager.close();
  });
  it("rejects old boot identity, invalid capability and invalid reply destinations before an action", async () => {
    const f = fixture();
    expect(() =>
      f.manager.submit({ ...f.command, binding: { ...f.command.binding, bootId: randomUUID() } }),
    ).toThrow("executor_replaced");
    expect(() => f.manager.submit({ ...f.command, replyTopic: "business-events" })).toThrow(
      "executor_invalid_reply_topic",
    );
    expect(() => f.manager.submit({ ...f.command, arguments: { x: -1, y: 4 } })).toThrow(
      "executor_invalid_arguments",
    );
    expect(f.execute).not.toHaveBeenCalled();
    await f.manager.close();
  });
  it("rejects overlapping commands and preserves cancellation without claiming undo", async () => {
    const f = fixture();
    let reject: (error: Error) => void = () => {};
    f.execute.mockImplementation(
      () =>
        new Promise((_resolve, r) => {
          reject = r;
        }),
    );
    f.manager.submit(f.command);
    await Promise.resolve();
    expect(() =>
      f.manager.submit({
        ...f.command,
        operationId: randomUUID(),
        position: { ...f.command.position, index: 1 },
      }),
    ).toThrow("executor_busy");
    f.manager.cancel({
      binding: f.command.binding,
      operationId: f.command.operationId,
      position: { ...f.command.position, offset: "121" },
    });
    reject(new Error("interrupted"));
    await settled(f);
    expect(f.publish).toHaveBeenCalledWith(
      f.command.replyTopic,
      expect.objectContaining({
        kind: "execution_failure",
        failure: expect.objectContaining({ effect: "unknown" }),
      }),
    );
    await f.manager.close();
  });
  it("ordinary UI errors remain tool results, transport loss remains unknown", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new AndroidToolError("Select a field"));
    f.manager.submit(f.command);
    await settled(f);
    expect(f.publish).toHaveBeenCalledWith(
      f.command.replyTopic,
      expect.objectContaining({
        kind: "tool_result",
        result: expect.objectContaining({ isError: true }),
      }),
    );
    f.execute.mockRejectedValueOnce(new Error("connection lost"));
    f.manager.submit({
      ...f.command,
      operationId: randomUUID(),
      position: { ...f.command.position, index: 1 },
    });
    await settled(f);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenLastCalledWith(
      f.command.replyTopic,
      expect.objectContaining({ kind: "execution_failure" }),
    );
    await f.manager.close();
  });
  it("HTTP acknowledges admission without waiting for Appium; guest has no unauthenticated command path", async () => {
    const f = fixture();
    let resolve: (value: { content: { type: "text"; text: string }[] }) => void = () => {};
    f.execute.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const server = createExecutorServer({
      token: "test-token",
      manager: f.manager,
      ready: () => true,
      screenshot: async () => "",
    });
    try {
      const path = "/internal/v1/executor/operations";
      expect(
        (await server.inject({ method: "POST", url: path, payload: f.command })).statusCode,
      ).toBe(401);
      const response = await server.inject({
        method: "POST",
        url: path,
        payload: f.command,
        headers: { authorization: "Bearer test-token" },
      });
      expect(response.json()).toEqual({ accepted: true });
      expect(f.publish).not.toHaveBeenCalled();
      resolve({ content: [{ type: "text", text: "ok" }] });
      await settled(f);
    } finally {
      await server.close();
      await f.manager.close();
    }
  });
});
