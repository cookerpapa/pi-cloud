import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SessionControlChange } from "@pi-cloud/protocol";
import { SandboxBindingView } from "../src/sandbox-binding-view.ts";
import type { SandboxBindingRecord } from "../src/sandbox-bindings.ts";

function fixture() {
  let row: SandboxBindingRecord | undefined = {
    bindingId: randomUUID(),
    tenantId: randomUUID(),
    runId: randomUUID(),
    writerId: randomUUID(),
    piSessionId: randomUUID(),
    revision: "1",
    instanceId: randomUUID(),
    baseUrl: "http://owner.test",
    dispatchClosed: false,
    descriptor: {
      version: 1,
      target: {
        apiUrl: "http://cube.test",
        sandboxId: "cube",
        nodeId: "node",
        bootId: randomUUID(),
      },
      initialization: {} as SandboxBindingRecord["descriptor"]["initialization"],
    },
    snapshot: {} as SandboxBindingRecord["snapshot"],
  };
  const original = row;
  const source = {
    loadView: vi.fn(async (): Promise<readonly SandboxBindingRecord[]> => (row ? [row] : [])),
    readChange: vi.fn(async () => row),
    closeScope: vi.fn(async () => {}),
    isAlive: vi.fn(async () => true),
  };
  const view = new SandboxBindingView({ source, partitionFor: () => 0 });
  const scope = { tenantId: original.tenantId, runId: original.runId, writerId: original.writerId };
  const change = (version: string, closed = false): SessionControlChange => ({
    kind: "control_change",
    factId: randomUUID(),
    scope: { tenantId: original.tenantId, piSessionId: original.piSessionId },
    entity: "sandbox_binding",
    entityId: original.bindingId,
    runId: original.runId,
    version,
    closed,
    occurredAt: new Date().toISOString(),
  });
  return {
    source,
    view,
    scope,
    original,
    change,
    set: (value: typeof row) => {
      row = value;
    },
  };
}

it("bootstraps once and serves repeated Run and writer lookups without storage reads", async () => {
  const f = fixture();
  await expect(f.view.find(f.scope, false)).rejects.toThrow("not recovered");
  await f.view.load([0], () => true);
  for (let n = 0; n < 1000; n++) {
    expect(await f.view.find(f.scope, false)).toHaveLength(1);
    expect(await f.view.find(f.scope, true)).toHaveLength(1);
  }
  expect(f.source.loadView).toHaveBeenCalledOnce();
  expect(f.source.readChange).not.toHaveBeenCalled();
  expect(await f.view.find({ ...f.scope, tenantId: randomUUID() }, true)).toEqual([]);
  expect(await f.view.find({ ...f.scope, runId: randomUUID() }, false)).toEqual([]);
});

it("closes dispatch before log consumption and cannot reopen through delayed open changes", async () => {
  const f = fixture();
  await f.view.load([0], () => true);
  f.set({ ...f.original, revision: "3", dispatchClosed: true });
  await f.view.prepare(f.change("3", true), () => true);
  expect((await f.view.find(f.scope, false))[0]?.dispatchClosed).toBe(true);
  await f.view.consume(f.change("2"), () => true);
  await f.view.consume(f.change("3", true), () => true);
  expect(f.source.readChange).toHaveBeenCalledOnce();
  expect((await f.view.find(f.scope, false))[0]?.dispatchClosed).toBe(true);
});

it("keeps new bindings out of the view until their ordered change is consumed", async () => {
  const f = fixture();
  f.set(undefined);
  await f.view.load([0], () => true);
  f.set(f.original);
  await f.view.prepare(f.change("1"), () => true);
  expect(await f.view.find(f.scope, false)).toEqual([]);
  expect(f.source.readChange).toHaveBeenCalledOnce();
  await f.view.consume(f.change("1"), () => true);
  expect(await f.view.find(f.scope, false)).toHaveLength(1);
  expect(f.source.readChange).toHaveBeenCalledTimes(2);
});

it("does not resurrect a deleted route after an older read completes", async () => {
  const f = fixture();
  await f.view.load([0], () => true);
  const old = Promise.withResolvers<SandboxBindingRecord | undefined>();
  f.source.readChange.mockImplementationOnce(() => old.promise);
  const reading = f.view.consume(f.change("2"), () => true);
  f.set(undefined);
  await f.view.prepare(f.change("3", true), () => true);
  old.resolve({ ...f.original, revision: "2" });
  await reading;
  expect(await f.view.find(f.scope, false)).toEqual([]);
});

it("discards both delayed bootstrap and event reads after assignment replacement", async () => {
  const f = fixture();
  const snapshot = Promise.withResolvers<readonly SandboxBindingRecord[]>();
  f.source.loadView.mockImplementationOnce(() => snapshot.promise);
  const load = f.view.load([0], () => true);
  f.view.reset();
  snapshot.resolve([f.original]);
  await load;
  await expect(f.view.find(f.scope, true)).rejects.toThrow("not recovered");
  await f.view.load([0], () => true);
  const old = Promise.withResolvers<SandboxBindingRecord | undefined>();
  f.source.readChange.mockImplementationOnce(() => old.promise);
  const reading = f.view.consume(f.change("2"), () => true);
  f.view.reset();
  f.set(undefined);
  await f.view.load([0], () => true);
  old.resolve({ ...f.original, revision: "2" });
  await reading;
  expect(await f.view.find(f.scope, true)).toEqual([]);
});

it("an old publication retry still installs current deletion before its Kafka send", async () => {
  const f = fixture();
  f.set({ ...f.original, revision: "10" });
  await f.view.load([0], () => true);
  const old = Promise.withResolvers<SandboxBindingRecord | undefined>();
  f.source.readChange.mockImplementationOnce(() => old.promise);
  const reading = f.view.consume(f.change("11"), () => true);
  f.set(undefined);
  await f.view.prepare(f.change("8"), () => true);
  old.resolve({ ...f.original, revision: "11" });
  await reading;
  expect(await f.view.find(f.scope, false)).toEqual([]);
});

it("keeps Run-scoped bindings distinct even when they share an activation identity", async () => {
  const f = fixture();
  const child = { ...f.original, runId: randomUUID() };
  f.source.loadView.mockResolvedValueOnce([f.original, child]);
  await f.view.load([0], () => true);
  expect(await f.view.find(f.scope, true)).toHaveLength(2);
  f.set({ ...f.original, revision: "2", dispatchClosed: true });
  await f.view.prepare(f.change("2", true), () => true);
  expect((await f.view.find(f.scope, false))[0]?.dispatchClosed).toBe(true);
  expect((await f.view.find({ ...f.scope, runId: child.runId }, false))[0]?.dispatchClosed).toBe(
    false,
  );
});

it("does not serve routes for another partition or replace missing state with an open default", async () => {
  const f = fixture();
  await f.view.load([1], () => true);
  expect(await f.view.find(f.scope, true)).toEqual([]);
  await expect(f.view.consume(f.change("2"), () => true)).rejects.toThrow("owner");
  await f.view.load([0], () => true);
  f.set(undefined);
  await f.view.consume(f.change("2", true), () => true);
  expect(await f.view.find(f.scope, true)).toEqual([]);
});
