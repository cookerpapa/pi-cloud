import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createExecutionReference } from "@pi-cloud/protocol";
import type { SandboxBindingRecord } from "../src/sandbox-bindings.ts";
import type { CubeSandboxProvider } from "../src/cubesandbox-sandbox-provider.ts";
import type { SandboxHandle } from "../src/sandbox-provider.ts";
import { SessionBindingExecution } from "../src/session-binding-execution.ts";

function fixture() {
  const writer = randomUUID(),
    run = randomUUID(),
    physical = randomUUID();
  const reference = createExecutionReference(writer, run, 1);
  const assignment = {
    tenantId: "tenant",
    projectId: "project",
    workspaceId: "workspace",
    supervisorId: "worker",
    bootId: randomUUID(),
    sandboxId: randomUUID(),
    runId: run,
    sessionId: randomUUID(),
    turnId: randomUUID(),
    executionReference: reference,
  };
  const binding = (id = randomUUID()): SandboxBindingRecord => ({
    bindingId: id,
    instanceId: "management-is-offline",
    baseUrl: "http://management.invalid",
    dispatchClosed: false,
    tenantId: "tenant",
    runId: run,
    writerId: writer,
    piSessionId: randomUUID(),
    revision: "1",
    descriptor: {
      version: 2,
      target: {
        apiUrl: "http://cube.invalid",
        sandboxId: "cube-1",
        nodeId: "node-1",
        bootId: randomUUID(),
      },
      attachment: { activationId: id, toolRoot: "/workspace" },
      dataCapsule: "encrypted-fixture",
    },
    snapshot: {
      assignment,
      physicalActivationId: physical,
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      allowedTools: ["bash"],
      sandboxProfileKey: "starter",
    },
  });
  const first = binding(),
    second = binding();
  const routes = new Map([
    [first.bindingId, first],
    [second.bindingId, second],
  ]);
  const handle = { activationId: physical, runtimeId: randomUUID(), assignment } as SandboxHandle;
  const provider = {
    attachExecutionData: vi.fn(() => handle),
    clearExecutionData: vi.fn(),
    openWorkflow: vi.fn(async () => new PassThrough()),
    preparePackage: vi.fn<CubeSandboxProvider["preparePackage"]>(async () => ({
      path: "/workspace/skill",
    })),
    exportPackage: vi.fn(async () => ({ files: [] })),
    imageIo: vi.fn(),
    prepareInputImage: vi.fn(),
    discoverHttpServices: vi.fn(async () => ({
      listeningPorts: [3000],
      httpServices: [{ port: 3000, protocol: "http" as const }],
    })),
  };
  const services = { observe: vi.fn(async () => {}), end: vi.fn(), endRuntime: vi.fn() };
  const execution = new SessionBindingExecution({
    bindings: { binding: (id) => routes.get(id) },
    provider,
    services,
  });
  const request = (route = first) => ({
    toolBrokerProtocolVersion: 1 as const,
    type: "tool_sandbox.prepare_package" as const,
    requestId: randomUUID(),
    activationId: route.bindingId,
    assignment,
    operationId: randomUUID(),
    content: { files: [] } as any,
    digest: "c".repeat(64),
  });
  return {
    first,
    second,
    reference,
    assignment,
    handle,
    routes,
    provider,
    execution,
    request,
    services,
  };
}

describe("Session execution without a management owner", () => {
  it("prepares a bound Skill and refreshes preview services through recorded data transport", async () => {
    const f = fixture();
    try {
      expect(await f.execution.preparePackage(f.request())).toMatchObject({
        type: "tool_sandbox.package_prepared",
      });
      await f.execution.refreshServices(f.first.bindingId, f.assignment);
      expect(f.provider.attachExecutionData).toHaveBeenCalledWith(f.first.descriptor);
      expect(f.services.observe).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: f.handle.runtimeId,
          activationId: f.first.bindingId,
          target: expect.objectContaining({ tenantId: "tenant", workspaceId: "workspace" }),
        }),
      );
    } finally {
      await f.execution.close();
    }
  });
  it("refuses foreign assignments and prepared revocation before physical I/O", async () => {
    const f = fixture();
    try {
      const wrong = f.request();
      wrong.assignment = { ...wrong.assignment, tenantId: "other" };
      await expect(f.execution.preparePackage(wrong)).rejects.toMatchObject({
        code: "tool_binding_closed",
      });
      f.routes.set(f.first.bindingId, { ...f.first, dispatchClosed: true });
      await expect(f.execution.preparePackage(f.request())).rejects.toMatchObject({
        code: "tool_binding_closed",
      });
      expect(f.provider.attachExecutionData).not.toHaveBeenCalled();
    } finally {
      await f.execution.close();
    }
  });
  it("rejects a capsule belonging to another Workspace before invoking guest helpers", async () => {
    const f = fixture();
    f.provider.attachExecutionData.mockReturnValue({
      ...f.handle,
      assignment: { ...f.assignment, workspaceId: "foreign" },
    });
    try {
      await expect(f.execution.preparePackage(f.request())).rejects.toThrow(
        "physical data scope changed",
      );
      expect(f.provider.preparePackage).not.toHaveBeenCalled();
    } finally {
      await f.execution.close();
    }
  });
  it("closes only unfinished operations on the selected binding in a shared VM", async () => {
    const f = fixture();
    const finishedBackground = await f.execution.preparePackage(f.request());
    const entered = Promise.withResolvers<void>();
    let secondFinished!: () => void;
    f.provider.preparePackage.mockImplementation(async (_handle, _input, signal) => {
      entered.resolve();
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        secondFinished = () => resolve({ path: "/workspace/other" });
      });
    });
    const first = f.execution.preparePackage(f.request());
    const firstOutcome = expect(first).rejects.toBeDefined();
    await entered.promise;
    await f.execution.closeBinding(f.first.bindingId);
    await firstOutcome;
    const sibling = f.execution.preparePackage(f.request(f.second));
    await Promise.resolve();
    await Promise.resolve();
    await f.execution.closeBinding(f.first.bindingId);
    secondFinished();
    await expect(sibling).resolves.toMatchObject({ path: "/workspace/other" });
    expect(finishedBackground.type).toBe("tool_sandbox.package_prepared");
    expect(f.provider.preparePackage).toHaveBeenCalledTimes(3);
    await f.execution.close();
  });
  it("cancels local workflow channels at partition loss without replaying their script", async () => {
    const f = fixture();
    const stream = new PassThrough();
    const opened = Promise.withResolvers<void>();
    f.provider.openWorkflow.mockImplementation(async () => {
      opened.resolve();
      return stream;
    });
    const request = {
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.operation" as const,
      operation: "workflow.exec" as const,
      activationId: f.first.bindingId,
      operationId: randomUUID(),
      toolCallId: "call",
      toolName: "bash" as const,
      script: "return 1",
      cwd: "/workspace",
      timeoutMs: 5000,
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "d".repeat(64),
    };
    const result = f.execution.executeWorkflow(f.reference, request);
    const rejected = expect(result).rejects.toBeDefined();
    await opened.promise;
    f.execution.reset();
    await rejected;
    expect(f.provider.openWorkflow).toHaveBeenCalledOnce();
    expect(stream.destroyed).toBe(true);
    await f.execution.close();
  });
});
