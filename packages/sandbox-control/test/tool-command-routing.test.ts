import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createExecutionReference, type AcceptedToolCommand } from "@pi-cloud/protocol";
import { ToolCommandDispatcher, toolDeliveryFact } from "../src/tool-command-dispatcher.ts";
import { CubeSandboxToolExecutor } from "../src/cubesandbox-tool-executor.ts";
import {
  CubeExecutionRejected,
  CubeRuntimeTransportError,
  CubeRuntimeClientError,
  type CubeSandboxRuntimeClient,
} from "../src/cubesandbox-runtime-client.ts";
import type { SandboxBinding, SandboxBindingReader } from "../src/sandbox-bindings.ts";
import { SandboxBindingView } from "../src/sandbox-binding-view.ts";

function fixture() {
  const scope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    piSessionId: randomUUID(),
    turnId: randomUUID(),
    runId: randomUUID(),
    writerId: randomUUID(),
    fencingToken: 1,
  };
  const command: AcceptedToolCommand = {
    kind: "tool_command",
    toolCallId: "result-entry",
    replyTopic: "pi-cloud.tool-replies.v4." + randomUUID(),
    occurredAt: new Date().toISOString(),
    scope,
    request: {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      activationId: randomUUID(),
      operationId: randomUUID(),

      toolName: "bash",
      operation: "tool.execute",
      toolCallId: "native",
      args: { command: "echo once" },
      maximumOutputBytes: 51200,
      timeoutMs: 1000,
    },
  };
  const route: SandboxBinding = {
    bindingId: command.request.activationId,
    instanceId: randomUUID(),
    baseUrl: "http://controller:4300",
    dispatchClosed: false,
    descriptor: {
      version: 2,
      target: {
        apiUrl: "http://cube.test",
        sandboxId: "aabbccddeeff00112233445566778899",
        nodeId: "node-1",
        bootId: randomUUID(),
      },
      attachment: {
        activationId: command.request.activationId,
        toolRoot: "/workspace",
      },
    },
    snapshot: {
      assignment: {
        ...scope,
        workspaceId: randomUUID(),
        projectId: randomUUID(),
        supervisorId: "worker",
        bootId: randomUUID(),
        sandboxId: randomUUID(),
        executionReference: createExecutionReference(scope.writerId, scope.runId, 1),
      },
      physicalActivationId: randomUUID(),
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      allowedTools: ["bash"],
      sandboxProfileKey: "standard",
    },
  };
  const get = vi.fn<SandboxBindingReader["get"]>(async () => route);
  const closeWriter = vi.fn(async () => {
    get.mockResolvedValue({ ...route, dispatchClosed: true });
  });
  const cube = {
    submitTool: vi.fn<CubeSandboxRuntimeClient["submitTool"]>(async () => {}),
    cancelTool: vi.fn<CubeSandboxRuntimeClient["cancelTool"]>(async () => {}),
  };
  const workflow = vi.fn(async () => {}),
    publishReply = vi.fn<ConstructorParameters<typeof ToolCommandDispatcher>[0]["publishReply"]>(
      async () => {},
    ),
    quarantine = vi.fn(async () => {});
  const options = {
    routes: { get, closeWriter, isAlive: async () => true },
    executor: new CubeSandboxToolExecutor(cube, {
      issue: async (grant) => ({
        url: "https://completion.test/v1/completions",
        address: "127.0.0.1",
        ca: "fixture",
        capability: JSON.stringify(grant),
        expiresAt: grant.expiresAt,
      }),
    }),
    workflow,
    publishReply,
    quarantine,
  };
  return {
    command,
    route,
    get,
    closeWriter,
    cube,
    workflow,
    publishReply,
    quarantine,
    options,
    router: new ToolCommandDispatcher(options),
  };
}
const record = (fact: any, offset = 0n) => ({ fact, topic: "session-log", partition: 0, offset });

it("preserves VM position order across distinct bindings of a shared Workspace", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>();
  const other = { ...f.route, bindingId: randomUUID() };
  f.get.mockImplementation(async (_scope, id) => (id === other.bindingId ? other : f.route));
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: {
      ensure: async (_scope, environment) => {
        if (environment.requestId === f.route.bindingId) await ready.promise;
        return environment.requestId === other.bindingId ? other : f.route;
      },
      retireWriter: vi.fn(),
    },
  });
  const send = (route: SandboxBinding, offset: bigint) =>
    router.consume(
      record(
        {
          ...f.command,
          environment: { requestId: route.bindingId, assignment: route.snapshot.assignment },
          request: {
            ...f.command.request,
            activationId: route.bindingId,
            operationId: randomUUID(),
          },
        },
        offset,
      ),
      () => true,
    );
  try {
    await send(f.route, 10n);
    await send(other, 11n);
    await new Promise<void>((resolve) => setImmediate(resolve));
    ready.resolve();
    await vi.waitFor(() => expect(f.cube.submitTool).toHaveBeenCalledTimes(2));
    expect(f.cube.submitTool.mock.calls.map((call) => call[1].source.offset)).toEqual(["10", "11"]);
  } finally {
    ready.resolve();
    await router.close();
  }
});

it("keeps a later cancellation behind pending handoffs without blocking Kafka consumption", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>();
  const order: string[] = [];
  f.cube.submitTool.mockImplementation(async (_target, request) => {
    order.push(request.source.offset);
  });
  f.cube.cancelTool.mockImplementation(async (_target, request) => {
    order.push(request.source.offset);
  });
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: {
      ensure: async () => {
        await ready.promise;
        return f.route;
      },
      retireWriter: vi.fn(),
    },
  });
  try {
    await router.consume(
      record(
        {
          ...f.command,
          environment: {
            requestId: f.route.bindingId,
            assignment: f.route.snapshot.assignment,
          },
        },
        10n,
      ),
      () => true,
    );
    await router.consume(
      record(
        {
          kind: "tool_cancel",
          scope: f.command.scope,
          request: { activationId: f.route.bindingId, operationId: randomUUID() },
        },
        12n,
      ),
      () => true,
    );
    ready.resolve();
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(["10", "12"]);
  } finally {
    ready.resolve();
    await router.close();
  }
});

it("lets another Workspace hand off while a cold Workspace is still preparing", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>();
  const other = {
    ...f.route,
    bindingId: randomUUID(),
    snapshot: {
      ...f.route.snapshot,
      assignment: { ...f.route.snapshot.assignment, workspaceId: randomUUID() },
    },
    descriptor: {
      ...f.route.descriptor,
      target: { ...f.route.descriptor.target, sandboxId: "b".repeat(32) },
    },
  };
  f.get.mockImplementation(async (_scope, id) => (id === other.bindingId ? other : f.route));
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: {
      ensure: async (_scope, environment) => {
        if (environment.requestId === f.route.bindingId) await ready.promise;
        return environment.requestId === other.bindingId ? other : f.route;
      },
      retireWriter: vi.fn(),
    },
  });
  try {
    for (const [route, offset] of [
      [f.route, 10n],
      [other, 11n],
    ] as const)
      await router.consume(
        record(
          {
            ...f.command,
            environment: { requestId: route.bindingId, assignment: route.snapshot.assignment },
            request: {
              ...f.command.request,
              activationId: route.bindingId,
              operationId: randomUUID(),
            },
          },
          offset,
        ),
        () => true,
      );
    await vi.waitFor(() => expect(f.cube.submitTool).toHaveBeenCalledOnce());
    expect(f.cube.submitTool.mock.calls[0]![0]).toEqual(other.descriptor.target);
  } finally {
    ready.resolve();
    await router.close();
  }
});

it("orders retained cleanup for a deleted binding before future handoffs", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>();
  const deleted = randomUUID(),
    order: string[] = [];
  f.get.mockImplementation(async (_scope, id) => (id === deleted ? undefined : f.route));
  f.cube.submitTool.mockImplementation(async (_target, request) => {
    order.push(request.source.offset);
  });
  f.cube.cancelTool.mockImplementation(async (_target, request) => {
    order.push(request.source.offset);
  });
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: {
      ensure: async () => {
        await ready.promise;
        return f.route;
      },
      retireWriter: vi.fn(),
    },
  });
  const send = (offset: bigint) =>
    router.consume(
      record(
        {
          ...f.command,
          environment: { requestId: f.route.bindingId, assignment: f.route.snapshot.assignment },
          request: { ...f.command.request, operationId: randomUUID() },
        },
        offset,
      ),
      () => true,
    );
  try {
    await send(10n);
    await router.cancelRetiredBinding(
      {
        kind: "control_change",
        entity: "sandbox_binding",
        factId: randomUUID(),
        scope: { tenantId: f.command.scope.tenantId, piSessionId: f.command.scope.piSessionId },
        entityId: deleted,
        runId: f.command.scope.runId,
        version: "1",
        closed: true,
        occurredAt: new Date().toISOString(),
        cancelTarget: { ...f.route.descriptor.target, writerId: f.command.scope.writerId },
      },
      { topic: "session-log", partition: 0, offset: "12" },
      () => true,
    );
    await send(13n);
    ready.resolve();
    await vi.waitFor(() => expect(order).toHaveLength(3));
    expect(order).toEqual(["10", "12", "13"]);
  } finally {
    ready.resolve();
    await router.close();
  }
});

it("does not block the partition on lazy preparation and consumes cancellation before handoff", async () => {
  const f = fixture();
  const prepared = Promise.withResolvers<void>();
  const ensure = vi.fn(async () => {
    await prepared.promise;
    return f.route;
  });
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: { ensure, retireWriter: vi.fn() },
  });
  await router.consume(
    record(
      {
        ...f.command,
        environment: { requestId: f.route.bindingId, assignment: f.route.snapshot.assignment },
      },
      10n,
    ),
    () => true,
  );
  expect(f.cube.submitTool).not.toHaveBeenCalled();
  await router.consume(
    record(
      {
        kind: "tool_cancel",
        scope: f.command.scope,
        request: { operationId: f.command.request.operationId, activationId: f.route.bindingId },
      },
      11n,
    ),
    () => true,
  );
  prepared.resolve();
  await router.close();
  expect(f.cube.submitTool).not.toHaveBeenCalled();
});

it("retains source ordering for several pending calls sharing one binding", async () => {
  const f = fixture(),
    prepared = Promise.withResolvers<void>();
  const router = new ToolCommandDispatcher({
    ...f.options,
    environments: {
      ensure: async () => {
        await prepared.promise;
        return f.route;
      },
      retireWriter: vi.fn(),
    },
  });
  for (const offset of [10n, 11n])
    await router.consume(
      record(
        {
          ...f.command,
          environment: { requestId: f.route.bindingId, assignment: f.route.snapshot.assignment },
          request: { ...f.command.request, operationId: randomUUID() },
        },
        offset,
      ),
      () => true,
    );
  prepared.resolve();
  await vi.waitFor(() => expect(f.cube.submitTool).toHaveBeenCalledTimes(2));
  expect(f.cube.submitTool.mock.calls.map((call) => call[1].source.offset)).toEqual(["10", "11"]);
  await router.close();
});

describe("Projector native Cube handoff", () => {
  it.each([
    [new CubeRuntimeTransportError(new Error("socket closed")), "tool_handoff_unconfirmed"],
    [new CubeRuntimeClientError("gateway timeout", 504), "tool_handoff_unconfirmed"],
    [new CubeRuntimeClientError("wrong operation identity"), "cubesandbox_tool_result_unknown"],
    [new CubeRuntimeClientError("access refused", 403), "cubesandbox_tool_result_unknown"],
  ])("distinguishes missing handoff transport from invalid replies: %s", async (error, code) => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(error);
    await f.router.consume(record(f.command));
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.quarantine).not.toHaveBeenCalled();
    expect(f.publishReply.mock.calls[0]?.[1]).toMatchObject({
      kind: "execution_failure",
      failure: { code, effect: "unknown" },
    });
  });
  it("cancels the exact invocation even after new-command routing has closed", async () => {
    const f = fixture();
    f.get.mockResolvedValue({ ...f.route, dispatchClosed: true });
    const scope = f.command.scope;
    const cancel = {
      kind: "tool_cancel",
      scope,
      request: { activationId: f.route.bindingId, operationId: f.command.request.operationId },
    };
    await f.router.consume(record(cancel, 101n));
    await f.router.consume(record(cancel, 101n));
    expect(f.cube.cancelTool).toHaveBeenCalledTimes(2);
    expect(f.cube.cancelTool).toHaveBeenLastCalledWith(f.route.descriptor.target, {
      source: { topic: "session-log", partition: 0, offset: "101" },
      executionScopeId: f.route.bindingId,
      writerId: scope.writerId,
      operationId: cancel.request.operationId,
    });
    expect(f.cube.submitTool).not.toHaveBeenCalled();
    expect(f.publishReply).not.toHaveBeenCalled(); // Acceptance is not a final result.
  });
  it("bounds an unavailable cancellation endpoint without fabricating stopping or deleting a VM", async () => {
    const f = fixture();
    f.cube.cancelTool.mockRejectedValue(new Error("unreachable"));
    const scope = f.command.scope;
    await f.router.consume(
      record({
        kind: "tool_cancel",
        scope,
        request: { activationId: f.route.bindingId, operationId: f.command.request.operationId },
      }),
    );
    expect(f.cube.cancelTool).toHaveBeenCalledTimes(2);
    expect(f.cube.submitTool).not.toHaveBeenCalled();
    expect(f.publishReply).not.toHaveBeenCalled();
    expect(f.quarantine).not.toHaveBeenCalled();
  });
  it("retains a durable cancellation target after its binding row is removed", async () => {
    const f = fixture();
    f.get.mockResolvedValue(undefined);
    const change = {
      kind: "control_change" as const,
      entity: "sandbox_binding" as const,
      entityId: f.route.bindingId,
      scope: f.command.scope,
      runId: f.command.scope.runId,
      factId: randomUUID(),
      version: "2",
      occurredAt: new Date().toISOString(),
      closed: true,
      cancelTarget: { ...f.route.descriptor.target, writerId: f.command.scope.writerId },
    };
    await f.router.cancelRetiredBinding(
      change,
      { topic: "session-log", partition: 0, offset: "102" },
      () => true,
    );
    expect(f.cube.cancelTool).toHaveBeenCalledWith(f.route.descriptor.target, {
      source: { topic: "session-log", partition: 0, offset: "102" },
      executionScopeId: f.route.bindingId,
      writerId: f.command.scope.writerId,
    });
    // Memory is consulted only to choose the shared-resource order. The saved
    // target still works when its binding has already been removed.
    expect(f.get).toHaveBeenCalledOnce();
  });
  it("dispatches repeated fixed Tools from the binding view without a per-Tool lookup", async () => {
    const f = fixture();
    const source = {
      loadView: vi.fn(async () => [
        {
          ...f.route,
          tenantId: f.command.scope.tenantId,
          runId: f.command.scope.runId,
          writerId: f.command.scope.writerId,
          piSessionId: f.command.scope.piSessionId,
          revision: "1",
        },
      ]),
      readChange: vi.fn(async () => undefined),
      closeWriter: f.closeWriter,
      isAlive: async () => true,
    };
    const routes = new SandboxBindingView({ source, partitionCount: 2, partitionFor: () => 0 });
    await routes.load([0], () => true);
    const router = new ToolCommandDispatcher({ ...f.options, routes });
    for (let i = 0; i < 100; i++)
      await router.consume(
        record({ ...f.command, request: { ...f.command.request, operationId: randomUUID() } }),
      );
    expect(f.cube.submitTool).toHaveBeenCalledTimes(100);
    expect(f.get).not.toHaveBeenCalled();
    expect(source.readChange).not.toHaveBeenCalled();
    expect(source.loadView).toHaveBeenCalledOnce();
  });
  it("ignores display/results without SQL and hands fixed Tools directly to Cube", async () => {
    const f = fixture();
    const observation = { kind: "agent_event", scope: f.command.scope };
    expect(toolDeliveryFact(observation)).toBeUndefined();
    await f.router.consume(record(observation));
    expect(f.get).not.toHaveBeenCalled();
    await f.router.consume(record(f.command, 1n));
    expect(f.cube.submitTool).toHaveBeenCalledWith(
      f.route.descriptor.target,
      expect.objectContaining({
        operationId: f.command.request.operationId,
        executionScopeId: f.route.bindingId,
        writerId: f.command.scope.writerId,
        payload: expect.objectContaining({
          toolWorkerProtocolVersion: 7,
          type: "worker.operation",
          attachment: f.route.descriptor.attachment,
          request: f.command.request,
          delivery: expect.objectContaining({ url: "https://completion.test/v1/completions" }),
        }),
        completionContext: expect.objectContaining({
          url: "https://completion.test/v1/completions",
        }),
      }),
    );
    const submitted = vi.mocked(f.cube.submitTool).mock.calls[0]![1];
    expect(
      JSON.parse((submitted.completionContext as { capability: string }).capability),
    ).toMatchObject({
      issuer: "executor",
      context: { toolCallId: "result-entry", nativeToolCallId: "native" },
    });
    expect(f.workflow).not.toHaveBeenCalled();
    expect(f.publishReply).not.toHaveBeenCalled(); // The Guest delivers through its scoped callback.
    await f.router.consume(
      record({ ...f.command, request: { ...f.command.request, operationId: randomUUID() } }, 2n),
    );
    expect(f.get).toHaveBeenCalledTimes(4); // grouping and admission recheck; both memory reads
  });
  it("reconstructs transport metadata after dispatcher replacement", async () => {
    const f = fixture();
    await new ToolCommandDispatcher(f.options).consume(record(f.command));
    const next = { ...f.command, request: { ...f.command.request, operationId: randomUUID() } };
    await new ToolCommandDispatcher(f.options).consume(record(next, 1n));
    expect(f.get).toHaveBeenCalledTimes(4);
    expect(f.cube.submitTool.mock.calls.map((args) => args[0])).toEqual([
      f.route.descriptor.target,
      f.route.descriptor.target,
    ]);
  });
  it("does not dispatch after partition ownership changes during the binding read", async () => {
    const f = fixture();
    let current = true;
    f.get.mockImplementation(async () => {
      current = false;
      return f.route;
    });
    await f.router.consume(record(f.command), () => current);
    expect(f.cube.submitTool).not.toHaveBeenCalled();
  });
  it("leaves an uncertain handoff running without replaying or quarantining it", async () => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new Error("ACK lost"));
    await f.router.consume(record(f.command));
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.quarantine).not.toHaveBeenCalled();
    expect(f.publishReply).toHaveBeenCalledWith(
      f.command.replyTopic,
      expect.objectContaining({
        kind: "execution_failure",
        failure: expect.objectContaining({
          code: "cubesandbox_tool_result_unknown",
          effect: "unknown",
        }),
      }),
      f.command.scope,
    );
  });
  it.each(["capacity", "execution_position_stale"])(
    "does not destroy or quarantine a VM for explicit %s refusal",
    async (code) => {
      const f = fixture();
      f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected(code));
      await f.router.consume(record(f.command));
      expect(f.quarantine).not.toHaveBeenCalled();
      expect(f.publishReply).toHaveBeenCalledOnce();
    },
  );
  it("quarantines a replaced executor rather than refreshing its boot and retrying", async () => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected("executor_replaced"));
    await f.router.consume(record(f.command));
    expect(f.quarantine).toHaveBeenCalledWith(f.route.descriptor.target);
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
  });
  it.each(["executor_replaced", "runtime_quarantined"])(
    "notifies the Worker while %s quarantine is still pending, then joins its failure",
    async (reason) => {
      const f = fixture(),
        pending = Promise.withResolvers<void>();
      f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected(reason));
      f.quarantine.mockImplementation(() => pending.promise);
      const handling = f.router.consume(record(f.command));
      const result = handling.catch((error) => error);
      await vi.waitFor(() => expect(f.publishReply).toHaveBeenCalledOnce());
      expect(f.publishReply.mock.calls[0]?.[1]).toMatchObject({
        failure: { code: "cubesandbox_tool_unavailable", effect: "unknown" },
      });
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      pending.reject(new Error("quarantine propagation failed"));
      expect(await result).toBeInstanceOf(AggregateError);
      expect(f.cube.submitTool).toHaveBeenCalledOnce();
      expect(f.publishReply).toHaveBeenCalledOnce();
      expect(f.cube.cancelTool).not.toHaveBeenCalled();
    },
  );
  it("attempts failure notification even when quarantine throws synchronously", async () => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected("executor_replaced"));
    f.quarantine.mockImplementation(() => {
      throw Error("synchronous lifecycle failure");
    });
    await expect(f.router.consume(record(f.command))).rejects.toBeInstanceOf(AggregateError);
    expect(f.publishReply).toHaveBeenCalledOnce();
  });
  it("still completes quarantine when the failure reply is lost, without replay or cancellation", async () => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected("executor_replaced"));
    f.publishReply.mockRejectedValue(new Error("reply transport unavailable"));
    await f.router.consume(record(f.command));
    expect(f.quarantine).toHaveBeenCalledOnce();
    expect(f.publishReply).toHaveBeenCalledOnce();
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.cube.cancelTool).not.toHaveBeenCalled();
  });
  it.each([
    ["node_unavailable", "cubesandbox_tool_unavailable", "not_started"],
    ["execution_unavailable", "cubesandbox_tool_unavailable", "not_started"],
    ["execution_endpoint_unconfigured", "cubesandbox_tool_unavailable", "not_started"],
    ["executor_capacity", "cubesandbox_tool_unavailable", "not_started"],
    ["capacity", "tool_execution_not_started", "not_started"],
    ["invalid_request", "tool_execution_not_started", "not_started"],
    ["invalid_identity", "tool_execution_not_started", "not_started"],
    ["invalid_execution_position", "tool_execution_not_started", "not_started"],
    ["operation_changed", "cubesandbox_tool_result_unknown", "unknown"],
    ["execution_position_stale", "cubesandbox_tool_result_unknown", "unknown"],
    ["execution_stream_changed", "cubesandbox_tool_result_unknown", "unknown"],
    ["future_refusal", "cubesandbox_tool_result_unknown", "unknown"],
  ])("preserves %s refusal evidence without inventing effects", async (reason, code, effect) => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected(reason));
    await f.router.consume(record(f.command));
    expect(f.publishReply.mock.calls[0]?.[1]).toMatchObject({ failure: { code, effect } });
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.quarantine).not.toHaveBeenCalled();
  });
  it("refuses later routing after binding closure, including dispatcher replacement", async () => {
    const f = fixture();
    await f.router.consume(record(f.command));
    await f.router.consume(record({ kind: "execution_seal", scope: f.command.scope }));
    expect(f.closeWriter).toHaveBeenCalledExactlyOnceWith(f.command.scope, true);
    await f.router.closeWorkflowBinding(
      {
        kind: "control_change",
        entity: "sandbox_binding",
        entityId: f.route.bindingId,
        runId: f.command.scope.runId,
        scope: f.command.scope,
        closed: true,
        version: "2",
        factId: randomUUID(),
        occurredAt: new Date().toISOString(),
      },
      { ...f.route, dispatchClosed: true },
      { topic: "session-log", partition: 0, offset: "1" },
      () => true,
    );
    expect(f.quarantine).not.toHaveBeenCalled();
    const late = { ...f.command, request: { ...f.command.request, operationId: randomUUID() } };
    await f.router.consume(record(late, 2n));
    await new ToolCommandDispatcher(f.options).consume(record(late, 2n));
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.publishReply).toHaveBeenCalledTimes(2);
  });
  it("refuses a binding quarantined by another control-plane replica", async () => {
    const f = fixture();
    await f.router.consume(record(f.command));
    f.get.mockResolvedValue({ ...f.route, dispatchClosed: true });
    await f.router.consume(
      record({ ...f.command, request: { ...f.command.request, operationId: randomUUID() } }, 1n),
    );
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
  });
  it("waits only for writer routing revocation before sealing", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<void>();
    f.closeWriter.mockImplementation(() => pending.promise);
    let sealed = false;
    const closing = f.router
      .consume(record({ kind: "execution_seal", scope: f.command.scope }))
      .then(() => {
        sealed = true;
      });
    await Promise.resolve();
    expect(f.closeWriter).toHaveBeenCalledWith(f.command.scope, true);
    expect(sealed).toBe(false);
    pending.resolve();
    await closing;
    expect(sealed).toBe(true);
  });
  it("closes only the interactive workflow channel on a binding change", async () => {
    const f = fixture();
    const change = {
      kind: "control_change" as const,
      entity: "sandbox_binding" as const,
      entityId: f.route.bindingId,
      runId: f.command.scope.runId,
      scope: f.command.scope,
      closed: true,
      version: "2",
      factId: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    const source = { topic: "session-log", partition: 0, offset: "101" };
    for (let i = 0; i < 2; i++)
      expect(
        await f.router.closeWorkflowBinding(
          change,
          { ...f.route, dispatchClosed: true },
          source,
          () => true,
        ),
      ).toBeUndefined();
    expect(f.workflow).toHaveBeenCalledTimes(2);
    expect(f.cube.submitTool).not.toHaveBeenCalled();
    expect(f.closeWriter).not.toHaveBeenCalled();
    await expect(
      f.router.closeWorkflowBinding({ ...change, closed: false }, f.route, source, () => true),
    ).rejects.toThrow("not closed");
  });
});
