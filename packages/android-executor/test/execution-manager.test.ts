import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ANDROID_CAPABILITIES, type ExecutorOperation } from "@pi-cloud/protocol";
import { AndroidExecutionManager } from "../src/execution-manager.ts";
import { AndroidToolError } from "../src/appium-driver.ts";
import { createExecutorServer } from "../src/server.ts";
function fixture() {
  const targetId = randomUUID(),
    bootId = randomUUID();
  const execute = vi.fn<AndroidExecutionManager["options"]["execute"]>(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  const complete = vi.fn(
    async (
      _command: ExecutorOperation,
      _output: import("@pi-cloud/protocol").ExecutorCompletion,
    ) => {},
  );
  const manager = new AndroidExecutionManager({
    targetId,
    bootId,
    execute,
    complete,
  });
  const command: ExecutorOperation = {
    version: 2,
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
    deadlineAt: Date.now() + 30000,
    completion: {
      url: "https://completion.test/v1/completions",
      address: "127.0.0.1",
      ca: "-----BEGIN CERTIFICATE-----fixture",
      capability: "opaque",
      expiresAt: Date.now() + 90000,
    },
  };
  return { manager, command, execute, complete };
}
async function settled(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.manager.busy).toBe(false));
}
describe("Android external effect boundary", () => {
  it("retiring admission preserves an accepted action and exact old cancellation survives a newer binding", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    f.execute.mockImplementation(async (_name, _args, s) => {
      signal = s;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { content: [{ type: "text", text: "done" }] };
    });
    f.manager.submit(f.command);
    await Promise.resolve();
    f.manager.closeBinding(f.command.binding);
    expect(signal?.aborted).toBe(false);
    const next = {
      ...f.command,
      operationId: randomUUID(),
      binding: { ...f.command.binding, bindingId: randomUUID(), generation: "2" },
    };
    expect(() => f.manager.submit(next)).toThrow("executor_busy");
    expect(signal?.aborted).toBe(false);
    expect(() =>
      f.manager.cancel({
        binding: f.command.binding,
        operationId: f.command.operationId,
        position: f.command.position,
      }),
    ).toThrow("executor_cancel_position_stale");
    f.manager.cancel({
      binding: f.command.binding,
      operationId: f.command.operationId,
      position: { ...f.command.position, offset: "121" },
    });
    expect(signal?.aborted).toBe(true);
    finish();
    await settled(f);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.manager.close();
  });
  it("a recovered old cancellation cannot abort a newer action", async () => {
    const f = fixture();
    f.manager.submit(f.command);
    await settled(f);
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    f.execute.mockImplementation(async (_name, _args, s) => {
      signal = s;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { content: [{ type: "text", text: "done" }] };
    });
    const next = {
      ...f.command,
      operationId: randomUUID(),
      binding: { ...f.command.binding, bindingId: randomUUID(), generation: "2" },
    };
    f.manager.submit(next);
    await Promise.resolve();
    expect(() =>
      f.manager.cancel({
        binding: f.command.binding,
        operationId: f.command.operationId,
        position: { ...f.command.position, offset: "121" },
      }),
    ).toThrow("executor_binding_stale");
    expect(signal?.aborted).toBe(false);
    finish();
    await settled(f);
    await f.manager.close();
  });
  it("failed completion never reexecutes the UI action", async () => {
    const f = fixture();
    f.complete.mockRejectedValueOnce(new Error("lost acknowledgement"));
    f.manager.submit(f.command);
    await settled(f);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
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
  it("rejects old boot identity, expired deadlines and invalid completion before an action", async () => {
    const f = fixture();
    expect(() =>
      f.manager.submit({ ...f.command, binding: { ...f.command.binding, bootId: randomUUID() } }),
    ).toThrow("executor_replaced");
    expect(() =>
      f.manager.submit({
        ...f.command,
        completion: { ...f.command.completion, url: "http://wrong/v1/completions" },
      }),
    ).toThrow("executor_invalid_completion");
    expect(() => f.manager.submit({ ...f.command, deadlineAt: Date.now() - 1 })).toThrow(
      "executor_deadline_elapsed",
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
    expect(f.complete).toHaveBeenCalledWith(
      f.command,
      expect.objectContaining({
        type: "executor.unknown",
      }),
    );
    await f.manager.close();
  });
  it("ordinary UI errors remain tool results, transport loss remains unknown", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new AndroidToolError("Select a field"));
    f.manager.submit(f.command);
    await settled(f);
    expect(f.complete).toHaveBeenCalledWith(
      f.command,
      expect.objectContaining({
        type: "executor.result",
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
    expect(f.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolName: f.command.toolName,
        position: { ...f.command.position, index: 1 },
      }),
      expect.objectContaining({ type: "executor.unknown" }),
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
      expect(f.complete).not.toHaveBeenCalled();
      resolve({ content: [{ type: "text", text: "ok" }] });
      await settled(f);
    } finally {
      await server.close();
      await f.manager.close();
    }
  });
});
