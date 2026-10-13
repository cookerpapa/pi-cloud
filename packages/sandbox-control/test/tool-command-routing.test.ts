import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import { ToolCommandDispatcher, toolDeliveryFact } from "../src/tool-command-dispatcher.ts";
import {
  CubeExecutionRejected,
  type CubeSandboxRuntimeClient,
} from "../src/cubesandbox-runtime-client.ts";
import type { SandboxBinding } from "../src/sandbox-bindings.ts";
import { SandboxBindingView } from "../src/sandbox-binding-view.ts";

function fixture() {
  const scope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    piSessionId: randomUUID(),
    turnId: randomUUID(),
    runId: randomUUID(),
    writerId: randomUUID(),
    leaseId: randomUUID(),
    fencingToken: 1,
  };
  const command: AcceptedToolCommand = {
    kind: "tool_command",
    factId: randomUUID(),
    toolCallId: "result-entry",
    replyTopic: "pi-cloud.tool-replies.v3." + randomUUID(),
    occurredAt: new Date().toISOString(),
    scope,
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
  const route: SandboxBinding = {
    bindingId: command.request.activationId,
    instanceId: randomUUID(),
    baseUrl: "http://controller:4300",
    dispatchClosed: false,
    descriptor: {
      version: 1,
      target: {
        apiUrl: "http://cube.test",
        sandboxId: "aabbccddeeff00112233445566778899",
        nodeId: "node-1",
        bootId: randomUUID(),
      },
      initialization: {
        toolWorkerProtocolVersion: 4,
        type: "worker.initialize",
        activationId: command.request.activationId,
        toolRoot: "/workspace",
        workspaceSeed: { kind: "sample_java" },
        environment: {
          environmentVersionId: randomUUID(),
          versionNumber: 1,
          profileKey: "pi-cloud-fullstack",
          profileVersion: "1",
          imageRevision: "test",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
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
        executionReference: createExecutionReference(scope.leaseId, scope.runId, 1),
      },
      physicalActivationId: randomUUID(),
      turnContextSha256: command.request.turnContextSha256,
      executionContextSha256: command.request.executionContextSha256,
      allowedTools: ["bash"],
      sandboxProfileKey: "standard",
    },
  };
  const find = vi.fn(async () => [route]);
  const closeWriter = vi.fn(async () => {
    find.mockResolvedValue([{ ...route, dispatchClosed: true }]);
  });
  const cube = {
    submitTool: vi.fn<CubeSandboxRuntimeClient["submitTool"]>(async () => {}),
    cancelTool: vi.fn<CubeSandboxRuntimeClient["cancelTool"]>(async () => {}),
  };
  const workflow = vi.fn(async () => {}),
    publishReply = vi.fn(async () => {}),
    quarantine = vi.fn(async () => {});
  const options = {
    routes: { find, closeWriter, isAlive: async () => true },
    cube,
    workflow,
    publishReply,
    quarantine,
  };
  return {
    command,
    route,
    find,
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

describe("Projector native Cube handoff", () => {
  it("cancels the exact invocation even after new-command routing has closed", async () => {
    const f = fixture();
    f.find.mockResolvedValue([{ ...f.route, dispatchClosed: true }]);
    const { leaseId: _lease, ...scope } = f.command.scope;
    const cancel = {
      kind: "tool_cancel",
      factId: randomUUID(),
      scope,
      occurredAt: new Date().toISOString(),
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
    const { leaseId: _lease, ...scope } = f.command.scope;
    await f.router.consume(
      record({
        kind: "tool_cancel",
        factId: randomUUID(),
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
    f.find.mockResolvedValue([]);
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
    expect(f.find).not.toHaveBeenCalled();
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
    expect(f.find).not.toHaveBeenCalled();
    expect(source.readChange).not.toHaveBeenCalled();
    expect(source.loadView).toHaveBeenCalledOnce();
  });
  it("ignores display/results without SQL and hands fixed Tools directly to Cube", async () => {
    const f = fixture();
    const observation = { kind: "agent_event", scope: f.command.scope };
    expect(toolDeliveryFact(observation)).toBeUndefined();
    await f.router.consume(record(observation));
    expect(f.find).not.toHaveBeenCalled();
    await f.router.consume(record(f.command, 1n));
    expect(f.cube.submitTool).toHaveBeenCalledWith(
      f.route.descriptor.target,
      expect.objectContaining({
        operationId: f.command.request.operationId,
        executionScopeId: f.route.bindingId,
        writerId: f.command.scope.writerId,
        payload: {
          mode: "operation",
          initialization: f.route.descriptor.initialization,
          operation: f.command.request,
        },
        completionContext: expect.objectContaining({
          toolCallId: "result-entry",
          nativeToolCallId: "native",
        }),
      }),
    );
    expect(f.workflow).not.toHaveBeenCalled();
    expect(f.publishReply).not.toHaveBeenCalled(); // Native executor owns duration and final delivery.
    await f.router.consume(
      record({ ...f.command, request: { ...f.command.request, operationId: randomUUID() } }, 2n),
    );
    expect(f.find).toHaveBeenCalledTimes(2);
  });
  it("reconstructs transport metadata after dispatcher replacement", async () => {
    const f = fixture();
    await new ToolCommandDispatcher(f.options).consume(record(f.command));
    const next = { ...f.command, request: { ...f.command.request, operationId: randomUUID() } };
    await new ToolCommandDispatcher(f.options).consume(record(next, 1n));
    expect(f.find).toHaveBeenCalledTimes(2);
    expect(f.cube.submitTool.mock.calls.map((args) => args[0])).toEqual([
      f.route.descriptor.target,
      f.route.descriptor.target,
    ]);
  });
  it("does not dispatch after partition ownership changes during the binding read", async () => {
    const f = fixture();
    let current = true;
    f.find.mockImplementation(async () => {
      current = false;
      return [f.route];
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
    f.find.mockResolvedValue([{ ...f.route, dispatchClosed: true }]);
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
      .consume(record({ kind: "execution_seal", scope: f.command.scope, closesWriter: true }))
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
