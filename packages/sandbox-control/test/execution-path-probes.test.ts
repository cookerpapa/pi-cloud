import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createExecutionReference,
  type PathProbe,
  type RuntimeObservationScope,
  type ExecutionObservationDelivery,
} from "@pi-cloud/protocol";
import { toolReplyTopic } from "@pi-cloud/event-log";
import { ExecutionPathProbes } from "../src/execution-path-probes.ts";
import { executionTargetId } from "../src/sandbox-execution.ts";
import type { SandboxBinding, SandboxBindingReader } from "../src/sandbox-bindings.ts";
import { SandboxBindingView } from "../src/sandbox-binding-view.ts";

function fixture() {
  let now = Date.now();
  const scope: RuntimeObservationScope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    piSessionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    writerId: randomUUID(),
    fencingToken: 1,
  };
  const target = {
    apiUrl: "http://cube.test",
    sandboxId: "a".repeat(32),
    nodeId: "node",
    bootId: randomUUID(),
  };
  const route = (scope: RuntimeObservationScope): SandboxBinding => ({
    bindingId: randomUUID(),
    instanceId: "owner",
    baseUrl: "http://owner.test",
    dispatchClosed: false,
    descriptor: {
      version: 2,
      target,
      attachment: {
        activationId: "00000000-0000-4000-8000-000000000001",
        toolRoot: "/workspace",
      },
    },
    snapshot: {
      assignment: {
        tenantId: scope.tenantId,
        projectId: randomUUID(),
        workspaceId: randomUUID(),
        supervisorId: randomUUID(),
        bootId: randomUUID(),
        sandboxId: randomUUID(),
        runId: scope.runId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        executionReference: createExecutionReference(
          scope.writerId,
          scope.runId,
          scope.fencingToken,
        ),
      },
      physicalActivationId: randomUUID(),
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      allowedTools: ["bash"],
      sandboxProfileKey: "starter",
    },
  });
  const first = route(scope),
    sibling = { ...scope, runId: randomUUID(), turnId: randomUUID() },
    second = route(sibling);
  const get = vi.fn(async (_scope: unknown, id: string) =>
    [first, second].find((r) => r.bindingId === id),
  );
  const routes = { get } as unknown as SandboxBindingReader;
  const submitProbe = vi.fn(async () => {}),
    evidence = vi.fn(async () => {});
  const observer = { active: vi.fn(() => true), targets: vi.fn(), status: vi.fn() };
  const sample = vi.fn();
  const probes = new ExecutionPathProbes({
    routes,
    cube: { submitProbe },
    runtimeEvidence: evidence,
    sample,
    clock: () => now,
  });
  probes.observeWith(observer);
  const fact: PathProbe = {
    kind: "path_probe",
    factId: randomUUID(),
    scope,
    occurredAt: new Date(now).toISOString(),
    execution: {
      replyTopic: toolReplyTopic(randomUUID()),
      bindings: [
        { bindingId: first.bindingId, scope, probe: true },
        { bindingId: second.bindingId, scope: sibling, probe: true },
      ],
    },
  };
  const completion = (binding = first, who = scope): ExecutionObservationDelivery => ({
    kind: "probe",
    roundTripMs: 1,
    requestId: fact.factId,
    scope: who,
    partition: 0,
    sentAt: Date.parse(fact.occurredAt),
    evidence: {
      bindingId: binding.bindingId,
      targetId: executionTargetId(target),
      bootId: target.bootId,
      observedAt: now,
    },
  });
  return {
    sample,
    probes,
    observer,
    submitProbe,
    evidence,
    get,
    first,
    second,
    scope,
    sibling,
    fact,
    completion,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("publishes Projector status immediately and shares one guest probe across VM bindings", async () => {
  const f = fixture();
  try {
    f.probes.consume(f.fact);
    expect(f.observer.targets).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    expect(vi.mocked(f.submitProbe).mock.calls[0]).toMatchObject([
      expect.anything(),
      { completionContext: { bindingIds: [f.first.bindingId, f.second.bindingId] } },
    ]);
    f.probes.complete(f.completion());
    f.probes.complete(f.completion(f.second, f.sibling));
    await vi.waitFor(() => expect(f.evidence).toHaveBeenCalledOnce());
    expect(f.sample.mock.calls.filter(([stage]) => stage === "round_trip")).toHaveLength(1);
    expect(f.observer.status.mock.calls.filter(([, s]) => s.status === "confirmed")).toHaveLength(
      2,
    );
  } finally {
    await f.probes.close();
  }
});

it("requires a fresh matching probe and rechecks current binding admission before readiness", async () => {
  const f = fixture();
  try {
    expect(await f.probes.ready(f.completion())).toBe(false);
    f.probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    expect(await f.probes.ready({ ...f.completion(), requestId: "different" })).toBe(false);
    expect(
      await f.probes.ready({
        ...f.completion(),
        evidence: { ...f.completion().evidence, bootId: "old-boot" },
      }),
    ).toBe(false);
    expect(await f.probes.ready(f.completion())).toBe(true);
    expect(await f.probes.ready(f.completion())).toBe(true); // HTTP acknowledgement retry
    f.get.mockResolvedValueOnce({ ...f.first, dispatchClosed: true });
    expect(await f.probes.ready(f.completion())).toBe(false);
    f.get.mockResolvedValueOnce({
      ...f.first,
      descriptor: {
        ...f.first.descriptor,
        target: { ...f.first.descriptor.target, bootId: "replacement" },
      },
    });
    expect(await f.probes.ready(f.completion())).toBe(false);
    f.advance(10_001);
    expect(await f.probes.ready(f.completion())).toBe(false);
  } finally {
    await f.probes.close();
  }
});

it("does not let a pre-rebalance probe confirmation cross owner replacement", async () => {
  const f = fixture();
  try {
    f.probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    const route = Promise.withResolvers<SandboxBinding | undefined>();
    f.get.mockReturnValueOnce(route.promise);
    const ready = f.probes.ready(f.completion());
    f.probes.reset();
    route.resolve(f.first);
    expect(await ready).toBe(false);
  } finally {
    await f.probes.close();
  }
});

it("forwards a guest probe from the same memory view without a binding SELECT", async () => {
  const f = fixture();
  const source = {
    loadView: vi.fn(async () => [
      { ...f.first, ...f.scope, revision: "1" },
      { ...f.second, ...f.sibling, revision: "2" },
    ]),
    readChange: vi.fn(async () => undefined),
    closeWriter: async () => {},
    isAlive: async () => true,
  };
  const routes = new SandboxBindingView({ source, partitionCount: 2, partitionFor: () => 0 });
  await routes.load([0], () => true);
  const probes = new ExecutionPathProbes({ ...f.probes.options, routes });
  probes.observeWith(f.observer);
  try {
    probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    expect(f.get).not.toHaveBeenCalled();
    expect(source.readChange).not.toHaveBeenCalled();
  } finally {
    await probes.close();
    await f.probes.close();
  }
});
it("never probes absent chat bindings, but treats a missing expected binding as unavailable", async () => {
  const f = fixture();
  try {
    f.probes.consume({ ...f.fact, execution: { ...f.fact.execution!, bindings: [] } });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.submitProbe).not.toHaveBeenCalled();
    f.advance(15000);
    f.get.mockResolvedValue(undefined);
    f.probes.consume({
      ...f.fact,
      factId: randomUUID(),
      occurredAt: new Date(Date.parse(f.fact.occurredAt) + 15000).toISOString(),
    });
    await vi.waitFor(() => expect(f.observer.status).toHaveBeenCalled());
    expect(f.observer.status.mock.calls.every(([, s]) => s.status === "unavailable")).toBe(true);
  } finally {
    await f.probes.close();
  }
});
it("a return before the handoff HTTP ACK cannot regress from Worker to Cube stage", async () => {
  const f = fixture(),
    ack = Promise.withResolvers<void>();
  f.submitProbe.mockImplementation(() => ack.promise);
  try {
    f.probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    f.probes.complete(f.completion());
    ack.resolve();
    await vi.waitFor(() =>
      expect(
        f.observer.status.mock.calls.some(
          ([scope, s]) => scope.runId === f.sibling.runId && s.stage === "cube",
        ),
      ).toBe(true),
    );
    expect(
      f.observer.status.mock.calls.filter(([scope]) => scope.runId === f.scope.runId).at(-1)?.[1]
        .stage,
    ).toBe("worker");
  } finally {
    ack.resolve();
    await f.probes.close();
  }
});
it("expired, wrong-boot, closed and duplicate replies never fabricate fresh health", async () => {
  const f = fixture();
  try {
    f.probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    const wrong = f.completion();
    wrong.evidence.bootId = randomUUID();
    f.probes.complete(wrong);
    expect(f.evidence).not.toHaveBeenCalled();
    f.advance(11000);
    f.probes.complete(f.completion());
    f.probes.sweep();
    expect(f.evidence).not.toHaveBeenCalled();
    expect(f.observer.status.mock.calls.at(-1)?.[1]).toMatchObject({
      status: "unavailable",
      stage: "cube",
    });
    f.observer.active.mockReturnValue(false);
    f.probes.complete(f.completion());
    expect(f.evidence).not.toHaveBeenCalled();
  } finally {
    await f.probes.close();
  }
});

it("Projector reset discards pending acknowledgements even when the same Session is re-admitted", async () => {
  const f = fixture(),
    ack = Promise.withResolvers<void>();
  f.submitProbe.mockImplementation(() => ack.promise);
  try {
    f.probes.consume(f.fact);
    await vi.waitFor(() => expect(f.submitProbe).toHaveBeenCalledOnce());
    f.probes.reset();
    f.observer.status.mockClear();
    f.probes.complete(f.completion());
    ack.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.evidence).not.toHaveBeenCalled();
    expect(f.observer.status).not.toHaveBeenCalled();
  } finally {
    ack.resolve();
    await f.probes.close();
  }
});
