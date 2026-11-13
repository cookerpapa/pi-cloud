import { randomUUID } from "node:crypto";
import { it, expect, vi } from "vitest";
import { createDeviceGateway } from "../src/gateway.ts";
import { connectDevice } from "../src/connector.ts";
import { DeviceExecutionManager, createExecutorServer } from "../../executor-runtime/src/index.ts";
import {
  localToolDefinitions,
  LOCAL_CAPABILITIES,
  type ExecutorOperation,
} from "@pi-cloud/protocol";
import { HttpExecutorTransport } from "../../sandbox-control/src/executor-transport.ts";

it("keeps execution and original completion independent of the outbound link, without replay", async () => {
  const targetId = randomUUID(),
    bootId = randomUUID();
  const localToken = "l".repeat(32),
    deviceToken = "d".repeat(32),
    managementToken = "m".repeat(32);
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execute = vi.fn(async () => {
    await running;
    return { content: [{ type: "text" as const, text: "once" }] };
  });
  const complete = vi.fn(
    async (
      _command: ExecutorOperation,
      _reply: import("@pi-cloud/protocol").ExecutorCompletion,
    ) => {},
  );
  const manager = new DeviceExecutionManager({
    kind: "linux",
    tools: localToolDefinitions(),
    targetId,
    bootId,
    execute,
    complete,
  });
  const receiver = createExecutorServer({ manager, token: localToken, ready: () => true });
  const gateway = await createDeviceGateway({
    managementToken,
    deviceToken: (id) => (id === targetId ? deviceToken : undefined),
  });
  const transport = new HttpExecutorTransport(managementToken);
  const controllers: AbortController[] = [],
    links: Promise<void>[] = [];
  try {
    const receiverUrl = await receiver.listen({ host: "127.0.0.1", port: 0 });
    const origin = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = `${origin}/targets/${targetId}`;
    await expect(transport.inspect(endpoint)).rejects.toThrow();
    const start = () => {
      const controller = new AbortController();
      controllers.push(controller);
      links.push(
        connectDevice({
          url: origin.replace("http:", "ws:") + "/v1/device-links/" + targetId,
          deviceToken,
          receiverUrl,
          receiverToken: localToken,
          signal: controller.signal,
          retryMs: 10,
        }),
      );
      return controller;
    };
    const first = start();
    await vi.waitFor(async () =>
      expect(await transport.inspect(endpoint)).toMatchObject({ targetId, bootId, kind: "linux" }),
    );
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
        capabilities: [...LOCAL_CAPABILITIES],
      },
      position: { topic: "session", partition: 0, offset: "10", index: 0 },
      operationId: randomUUID(),
      toolName: "local_bash",
      nativeCallId: "call",
      arguments: { command: "printf once" },
      deadlineAt: Date.now() + 30_000,
      completion: {
        url: "https://completion.test/v1/completions",
        address: "127.0.0.1",
        ca: "-----BEGIN CERTIFICATE-----fixture",
        capability: "opaque",
        expiresAt: Date.now() + 90_000,
      },
    };
    await transport.submit(endpoint, command);
    expect(execute).toHaveBeenCalledOnce();
    first.abort();
    await links[0];
    finish();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(complete.mock.calls[0]?.[0]).toEqual(command);
    start();
    await vi.waitFor(async () =>
      expect(await transport.inspect(endpoint)).toMatchObject({ bootId }),
    );
    await expect(transport.submit(endpoint, command)).rejects.toMatchObject({
      failure: { effect: "unknown", code: "executor_position_stale" },
    });
    expect(execute).toHaveBeenCalledOnce();
    const forbidden = await fetch(`${origin}/targets/${targetId}/health/ready`, {
      headers: { authorization: "Bearer " + deviceToken },
    });
    expect(forbidden.status).toBe(401);
  } finally {
    finish();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(links);
    await transport.close();
    await gateway.close();
    await receiver.close();
    await manager.close();
  }
});
