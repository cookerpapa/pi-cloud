import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createExecutionReference, type AcceptedToolCommand } from "@pi-cloud/protocol";
import {
  ToolCommandRouter,
  httpToolLogDelivery,
  toolDeliveryFact,
  TOOL_BROKER_LOG_DELIVERY_PATH,
} from "../src/tool-command-router.ts";
import { ToolCommandExecutor } from "../src/tool-command-executor.ts";
import { ToolBrokerServer, type ToolBrokerBackend } from "../src/tool-broker-server.ts";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});
function command(): AcceptedToolCommand {
  return {
    kind: "tool_command",
    factId: randomUUID(),
    toolCallId: randomUUID(),
    replyTopic: "pi-cloud.tool-replies.v1.test",
    occurredAt: new Date().toISOString(),
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      piSessionId: randomUUID(),
      turnId: randomUUID(),
      runId: randomUUID(),
      writerId: randomUUID(),
      leaseId: randomUUID(),
      fencingToken: 1,
    },
    request: {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: randomUUID(),
      operationId: randomUUID(),
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "c".repeat(64),
      toolName: "bash",
      operation: "tool.execute",
      toolCallId: "native",
      args: { command: "echo once" },
      maximumOutputBytes: 51200,
      timeoutMs: 1000,
    },
  };
}
const record = (fact: any, offset = 0n) => ({ fact, topic: "test", partition: 0, offset });
const receipt = (c: AcceptedToolCommand) => ({
  kind: "pi_session_append",
  scope: c.scope,
  items: ["large private native transcript"],
  events: [
    {
      type: "tool.completed",
      payload: { toolCallId: c.toolCallId, output: "large private result" },
    },
  ],
});

describe("sharded Tool routing", () => {
  it("filters display and native results without route queries", async () => {
    const c = command(),
      route = {
        bindingId: c.request.activationId,
        instanceId: randomUUID(),
        baseUrl: "http://owner:4300",
      };
    const find = vi.fn(async () => [route]),
      deliver = vi.fn(async () => {});
    const router = new ToolCommandRouter({
      routes: { find, isAlive: async () => true },
      deliver,
    });
    resources.push(() => router.close());
    await router.consume(record({ kind: "agent_event", scope: c.scope }));
    expect(find).not.toHaveBeenCalled();
    await router.consume(record(c, 1n));
    await router.consume(record(receipt(c), 2n));
    expect(find).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(toolDeliveryFact(receipt(c))).toBeUndefined();
    let current = true;
    find.mockImplementationOnce(async () => {
      current = false;
      return [route];
    });
    await router.consume(record({ kind: "execution_seal", scope: c.scope }, 3n), () => current);
    expect(deliver).toHaveBeenCalledTimes(1); // rebalance during route lookup cannot dispatch
  });

  it("rebuilds routes after dispatcher replacement and refreshes all owners at a writer seal", async () => {
    const c = command(),
      route = {
        bindingId: c.request.activationId,
        instanceId: randomUUID(),
        baseUrl: "http://owner:4300",
      };
    const childRoute = { ...route, bindingId: randomUUID(), instanceId: randomUUID() };
    const find = vi.fn(async (_scope, wholeWriter) =>
      wholeWriter ? [route, childRoute] : [route],
    );
    const deliver = vi.fn(async () => {});
    for (const fact of [
      c,
      receipt(c),
      { kind: "execution_seal", scope: c.scope, closesWriter: true },
    ]) {
      const router = new ToolCommandRouter({
        routes: { find, isAlive: async () => true },
        deliver,
      });
      resources.push(() => router.close());
      await router.consume(record(fact));
    }
    expect(find).toHaveBeenLastCalledWith(c.scope, true);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("abandons uncertain committed command delivery without executing it twice", async () => {
    const c = command(),
      route = {
        bindingId: c.request.activationId,
        instanceId: randomUUID(),
        baseUrl: "http://owner:4300",
      };
    const isAlive = vi.fn(async () => true),
      deliver = vi.fn(async () => {
        throw new Error("lost ACK");
      });
    const router = new ToolCommandRouter({
      routes: { find: async () => [route], isAlive },
      deliver,
    });
    resources.push(() => router.close());
    await router.consume(record(c));
    expect(router.statistics().abandonedDeliveries).toBe(1);
    expect(deliver.mock.calls).toHaveLength(1);
  });

  it("requires Broker-only auth, rejects wrong boots, and publishes native results instead of HTTP retrieval", async () => {
    const c = command(),
      instanceId = randomUUID(),
      token = "r".repeat(64),
      serviceToken = "s".repeat(64);
    const executionReference = createExecutionReference(c.scope.leaseId, c.scope.runId, 1);
    const execute = vi.fn(async () => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.operation_result" as const,
      activationId: c.request.activationId,
      operationId: c.request.operationId,
      operation: "tool.execute" as const,
      event: {
        type: "tool_execution_end" as const,
        toolCallId: c.toolCallId,
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text" as const, text: "done" }], details: undefined },
      },
    }));
    const publishReply = vi.fn(async () => {});
    const executor = new ToolCommandExecutor({
      publishReply,
      broker: {
        execute,
        ownsToolBinding: (id) => id === c.request.activationId,
      },
    });
    resources.push(() => executor.close());
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      broker: {
        checkHealth: async () => {},
        close: async () => {},
        providerId: "test",
        activeCount: 0,
        admittedCount: 0,
        admissionWaitingCount: 0,
        maximumActiveSandboxes: 8,
        cleanPrewarmCount: 0,
      } as unknown as ToolBrokerBackend,
      logDelivery: {
        instanceId,
        token,
        checkHealth: () => {},
        receive: (d) => executor.receive({ ...d, offset: BigInt(d.offset) }),
      },
    });
    resources.push(() => server.close());
    const baseUrl = await server.listen(),
      route = { instanceId, baseUrl, bindingId: c.request.activationId };
    const frame = { instanceId, topic: "test", partition: 0, offset: "1", fact: c };
    for (const credential of [serviceToken, executionReference]) {
      const response = await fetch(new URL(TOOL_BROKER_LOG_DELIVERY_PATH, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(frame),
      });
      expect(response.status).toBe(401);
    }
    const send = httpToolLogDelivery(token);
    await expect(send(route, { ...frame, instanceId: randomUUID() })).rejects.toThrow("410");
    await send(route, frame);
    await send(route, frame); // ACK lost / consumer-group replay
    expect(execute).toHaveBeenCalledOnce();
    const response = await fetch(
      new URL(
        `/internal/v1/tool-operation-result?activationId=${c.request.activationId}&operationId=${c.request.operationId}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${executionReference}` } },
    );
    expect(response.status).toBe(404);
    await vi.waitFor(() => expect(publishReply).toHaveBeenCalledOnce());
    expect(executor.statistics().activeCommands).toBe(0);
    await send(route, { ...frame, offset: "3", fact: { kind: "execution_seal", scope: c.scope } });
    await send(route, frame); // delayed pre-seal RPC
    expect(execute).toHaveBeenCalledOnce();
  });
});
