import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseExecutionReference,
  type ToolEnvironmentRequest,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import { command } from "../../sandbox-supervisor/test/fixtures/durable-command.ts";
import { ToolEnvironmentCoordinator } from "../src/tool-environment-coordinator.ts";
import type { SandboxBinding } from "../src/sandbox-bindings.ts";

function fixture() {
  const p = command.payload,
    identity = parseExecutionReference(p.executionReference);
  const environment: ToolEnvironmentRequest = {
    toolBrokerProtocolVersion: 1,
    type: "tool_environment",
    requestId: randomUUID(),
    piSessionId: p.piSession.id,
    conversationId: 1,
    assignment: {
      tenantId: p.tenantId,
      projectId: p.projectId,
      workspaceId: p.workspaceId,
      sessionId: p.sessionId,
      turnId: p.turnId,
      runId: identity.runId,
      executionReference: p.executionReference,
      supervisorId: "worker",
      sandboxId: randomUUID(),
      bootId: randomUUID(),
    },
    workspaceSeedKind: "empty",
    allowedTools: ["bash"],
    sandboxProfileKey: "standard",
    executionMode: "elastic",
    toolRoot: "/workspace",
    environment: p.environment,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
  };
  const scope: AcceptedToolCommand["scope"] = {
    tenantId: p.tenantId,
    sessionId: p.sessionId,
    turnId: p.turnId,
    runId: identity.runId,
    piSessionId: p.piSession.id,
    writerId: identity.leaseId,
    fencingToken: identity.fencingToken,
  };
  let route: SandboxBinding | undefined;
  const ready = { bindingId: environment.requestId, dispatchClosed: false } as SandboxBinding;
  const gate = Promise.withResolvers<void>();
  const create = vi.fn(async (_request: unknown, signal?: AbortSignal) => {
    await Promise.race([
      gate.promise,
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal?.aborted) reject(signal.reason);
      }),
    ]);
    route = ready;
    return {} as never;
  });
  const coordinator = new ToolEnvironmentCoordinator({
    bindings: { get: async () => route },
    management: { create },
  });
  return {
    coordinator,
    scope,
    environment,
    gate,
    create,
    ready,
    route: (value: SandboxBinding) => {
      route = value;
    },
  };
}

it("coalesces one logical binding while its ordered view can advance independently", async () => {
  const f = fixture();
  try {
    const a = f.coordinator.ensure(f.scope, f.environment, () => true);
    const b = f.coordinator.ensure(f.scope, structuredClone(f.environment), () => true);
    void a.catch(() => {});
    void b.catch(() => {});
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty("piSessionId");
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty("workspaceSeedKind");
    f.gate.resolve();
    expect(await a).toBe(f.ready);
    expect(await b).toBe(f.ready);
    await f.coordinator.ensure(f.scope, f.environment, () => true);
    expect(f.create).toHaveBeenCalledOnce();
  } finally {
    f.gate.resolve();
    f.coordinator.reset();
  }
});

it("reconciles a lost create reply through the applied binding instead of allocating again", async () => {
  const f = fixture();
  f.create.mockImplementationOnce(async () => {
    f.route(f.ready);
    throw new Error("lost response");
  });
  expect(await f.coordinator.ensure(f.scope, f.environment, () => true)).toBe(f.ready);
  expect(f.create).toHaveBeenCalledOnce();
  f.coordinator.reset();
});

it("writer retirement invalidates an outstanding preparation without accepting a late result", async () => {
  const f = fixture();
  const pending = f.coordinator.ensure(f.scope, f.environment, () => true);
  void pending.catch(() => {});
  void pending.catch(() => {});
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  f.coordinator.retireWriter(f.scope.writerId);
  await expect(pending).rejects.toThrow();
  f.gate.resolve();
  f.coordinator.reset();
});

it("refuses another writer or changed frozen target before resource effects", async () => {
  const f = fixture();
  await expect(
    f.coordinator.ensure({ ...f.scope, writerId: randomUUID() }, f.environment, () => true),
  ).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
  const pending = f.coordinator.ensure(f.scope, f.environment, () => true);
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  await expect(
    f.coordinator.ensure(f.scope, { ...f.environment, toolRoot: "/different" }, () => true),
  ).rejects.toThrow("frozen");
  f.gate.resolve();
  await pending;
  f.coordinator.reset();
});
