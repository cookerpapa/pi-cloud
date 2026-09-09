import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createExecutionLease, type AcceptedToolCommand } from "@pi-cloud/protocol";
import {
  KafkaToolCommandConsumer,
  httpToolLogDelivery,
  toolDeliveryFact,
  TOOL_BROKER_LOG_DELIVERY_PATH,
} from "../src/kafka-tool-command-consumer.ts";
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
    occurredAt: new Date().toISOString(),
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      piSessionId: randomUUID(),
      turnId: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
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
      attemptContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "c".repeat(64),
      toolName: "bash",
      operation: "bash.exec",
      command: "echo once",
      cwd: "/workspace",
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
  it("filters deltas without route queries and forwards only small native acknowledgements", async () => {
    const c = command(),
      route = {
        bindingId: c.request.activationId,
        instanceId: randomUUID(),
        baseUrl: "http://owner:4300",
      };
    const find = vi.fn(async () => [route]),
      deliver = vi.fn(async () => {});
    const router = new KafkaToolCommandConsumer({
      brokers: ["unused:9092"],
      topic: "test",
      groupId: "shared",
      routes: { find, isAlive: async () => true },
      deliver,
    });
    resources.push(() => router.close());
    await router.consume(record({ kind: "agent_event", scope: c.scope }));
    expect(find).not.toHaveBeenCalled();
    await router.consume(record(c, 1n));
    await router.consume(record(receipt(c), 2n));
    expect(find).toHaveBeenCalledOnce();
    const frame = deliver.mock.calls.at(-1) as unknown as [unknown, { fact: unknown }];
    expect(frame[1].fact).toEqual({
      kind: "pi_session_append",
      scope: c.scope,
      events: [{ type: "tool.completed", payload: { toolCallId: c.toolCallId } }],
    });
    expect(toolDeliveryFact({ kind: "pi_session_append", scope: c.scope })).toBeUndefined();
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
      const router = new KafkaToolCommandConsumer({
        brokers: ["unused:9092"],
        topic: "test",
        groupId: "shared",
        routes: { find, isAlive: async () => true },
        deliver,
      });
      resources.push(() => router.close());
      await router.consume(record(fact));
    }
    expect(find).toHaveBeenLastCalledWith(c.scope, true);
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it("retries uncertain live-owner delivery but never sends it to a replacement boot", async () => {
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
    const router = new KafkaToolCommandConsumer({
      brokers: ["unused:9092"],
      topic: "test",
      groupId: "shared",
      routes: { find: async () => [route], isAlive },
      deliver,
    });
    resources.push(() => router.close());
    await expect(router.consume(record(c))).rejects.toThrow("lost ACK");
    isAlive.mockResolvedValue(false);
    await router.consume(record(c));
    expect(router.statistics().abandonedDeliveries).toBe(1);
    expect(deliver.mock.calls).toHaveLength(2);
  });

  it("requires Broker-only auth, rejects wrong boots, and gets large results directly from owner", async () => {
    const c = command(),
      instanceId = randomUUID(),
      token = "r".repeat(64),
      serviceToken = "s".repeat(64);
    const executionLease = createExecutionLease(c.scope.leaseId, c.scope.attemptId, 1);
    const execute = vi.fn(async () => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.operation_result" as const,
      activationId: c.request.activationId,
      operationId: c.request.operationId,
      operation: "bash.exec" as const,
      exitCode: 0,
      outputSha256: "d".repeat(64),
      outputChunks: [
        { seq: 1, stream: "stdout" as const, data: Buffer.alloc(96 * 1024).toString("base64") },
      ],
    }));
    const executor = new ToolCommandExecutor({
      broker: {
        execute,
        ownsToolBinding: (id) => id === c.request.activationId,
        assertToolResultReader: (id, lease) => {
          if (id !== c.request.activationId || lease !== executionLease)
            throw new Error("not owner");
        },
      },
    });
    resources.push(() => executor.close());
    const server = new ToolBrokerServer({
      host: "127.0.0.1",
      port: 0,
      serviceToken,
      commands: executor,
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
    for (const credential of [serviceToken, executionLease]) {
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
      { headers: { authorization: `Bearer ${executionLease}` } },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json()).length).toBeGreaterThan(96 * 1024);
    await send(route, { ...frame, offset: "2", fact: toolDeliveryFact(receipt(c))! });
    expect(executor.statistics().retainedResultBytes).toBe(0);
    await send(route, { ...frame, offset: "3", fact: { kind: "execution_seal", scope: c.scope } });
    await send(route, frame); // delayed pre-seal RPC
    expect(execute).toHaveBeenCalledOnce();
  });
});
