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
    replyTopic: "pi-cloud.tool-replies.v1." + randomUUID(),
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
        toolWorkerProtocolVersion: 2,
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
  const closeScope = vi.fn(async () => {
    find.mockResolvedValue([{ ...route, dispatchClosed: true }]);
  });
  const cube = {
    submitTool: vi.fn<CubeSandboxRuntimeClient["submitTool"]>(async () => {}),
    stopExecutionScope: vi.fn<CubeSandboxRuntimeClient["stopExecutionScope"]>(async () => {}),
  };
  const workflow = vi.fn(async () => {}),
    publishReply = vi.fn(async () => {}),
    quarantine = vi.fn(async () => {});
  const options = {
    routes: { find, closeScope, isAlive: async () => true },
    cube,
    workflow,
    publishReply,
    quarantine,
  };
  return {
    command,
    route,
    find,
    closeScope,
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
        runId: f.command.scope.runId,
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
  it("closes an uncertain handoff by operation ID without replaying it", async () => {
    const f = fixture();
    f.cube.submitTool.mockRejectedValue(new Error("ACK lost"));
    await f.router.consume(record(f.command));
    expect(f.cube.submitTool).toHaveBeenCalledOnce();
    expect(f.cube.stopExecutionScope).toHaveBeenCalledWith(f.route.descriptor.target, {
      operationId: f.command.request.operationId,
    });
    expect(f.quarantine).not.toHaveBeenCalled();
    expect(f.publishReply).toHaveBeenCalledWith(
      f.command.replyTopic,
      expect.objectContaining({
        event: expect.objectContaining({
          result: expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringContaining("cubesandbox_tool_result_unknown"),
              }),
            ],
          }),
        }),
      }),
      f.command.scope,
    );
  });
  it("records runtime quarantine before delivering an unconfirmed-stop failure", async () => {
    const f = fixture(),
      order: string[] = [];
    f.cube.submitTool.mockRejectedValue(new Error("unknown"));
    f.cube.stopExecutionScope.mockRejectedValue(new Error("node disappeared"));
    f.quarantine.mockImplementation(async () => {
      order.push("quarantine");
    });
    f.publishReply.mockImplementation(async () => {
      order.push("reply");
    });
    await f.router.consume(record(f.command));
    expect(order).toEqual(["quarantine", "reply"]);
    expect(f.quarantine).toHaveBeenCalledWith(f.route.descriptor.target);
  });
  it.each(["capacity", "scope_closed"])(
    "does not destroy or quarantine a VM for explicit %s refusal",
    async (code) => {
      const f = fixture();
      f.cube.submitTool.mockRejectedValue(new CubeExecutionRejected(code));
      await f.router.consume(record(f.command));
      expect(f.cube.stopExecutionScope).not.toHaveBeenCalled();
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
  it("refuses queued commands after unconfirmed stopping, including dispatcher replacement", async () => {
    const f = fixture();
    await f.router.consume(record(f.command));
    f.cube.stopExecutionScope.mockRejectedValue(new Error("node unavailable"));
    await f.router.consume(record({ kind: "execution_seal", scope: f.command.scope }));
    expect(f.closeScope).toHaveBeenCalledExactlyOnceWith(f.command.scope, false);
    expect(f.quarantine).toHaveBeenCalledOnce();
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
  it("coalesces a writer seal to one closure per physical target", async () => {
    const f = fixture();
    f.find.mockResolvedValue([f.route, { ...f.route, bindingId: randomUUID() }]);
    await f.router.consume(
      record({ kind: "execution_seal", scope: f.command.scope, closesWriter: true }),
    );
    expect(f.find).toHaveBeenCalledWith(f.command.scope, true);
    expect(f.cube.stopExecutionScope).toHaveBeenCalledExactlyOnceWith(f.route.descriptor.target, {
      writerId: f.command.scope.writerId,
    });
  });
});
