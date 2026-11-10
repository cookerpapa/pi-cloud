import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { GuestSubmit, GuestCancel } from "@pi-cloud/protocol/guest";
import { GuestExecutorStore } from "../src/guest-executor-store.ts";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pma-admit-")),
    path = join(directory, "state.db"),
    kernel = randomUUID();
  let now = 100000,
    store = new GuestExecutorStore(path, kernel, () => now);
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request: GuestSubmit = {
    version: 1,
    action: "submit",
    bootId: store.bootId,
    operationId: randomUUID(),
    scopeId: randomUUID(),
    writerId: randomUUID(),
    source: { topic: "session", partition: 0, offset: "10" },
    timeoutMs: 1000,
    payload: { value: "original" },
  };
  const cancel = (offset = "11", extra = {}): GuestCancel => ({
    version: 1,
    action: "cancel",
    bootId: store.bootId,
    scopeId: request.scopeId,
    writerId: request.writerId,
    operationId: request.operationId,
    source: { ...request.source, offset },
    ...extra,
  });
  return {
    get store() {
      return store;
    },
    request,
    cancel,
    now: (v: number) => (now = v),
    reopen: (boot = kernel) => {
      store.close();
      store = new GuestExecutorStore(path, boot, () => now);
      return store;
    },
  };
}
it("persists admission before launch and never grants a duplicate a second launch", () => {
  const f = fixture(),
    a = f.store.admit(f.request, 105000);
  expect(a.fresh).toBe(true);
  const b = f.store.admit(structuredClone(f.request), 105000);
  expect(b.fresh).toBe(false);
  expect(b.operation.token).toBe(a.operation.token);
  expect(() => f.store.admit({ ...f.request, payload: { value: "changed" } }, 105000)).toThrow(
    "operation_changed",
  );
  expect(f.store.list()).toHaveLength(1);
});
it("retains replay boundaries and outstanding registrations across a Guest service restart", () => {
  const f = fixture(),
    a = f.store.admit(f.request, 105000),
    epoch = f.store.bootId;
  f.reopen();
  expect(f.store.bootId).toBe(epoch);
  expect(f.store.admit(f.request, 105000)).toEqual({ fresh: false, operation: a.operation });
  f.store.claim(a.operation.id, a.operation.token, 123, "started");
  expect(() => f.store.claim(a.operation.id, a.operation.token, 124, "different")).toThrow(
    "operation_changed",
  );
});
it("rejects a delayed submit when cancellation reached the Guest first", () => {
  const f = fixture();
  expect(f.store.cancel(f.cancel())).toEqual([]);
  expect(() => f.store.admit(f.request, 105000)).toThrow("execution_position_stale");
});
it("cancels only the original unfinished scope and never completed background work", () => {
  const f = fixture(),
    a = f.store.admit(f.request, 105000).operation;
  expect(f.store.cancel(f.cancel("11", { writerId: randomUUID() }))).toEqual([]);
  expect(f.store.get(a.id)?.cancelled).toBe(0);
  expect(f.store.cancel(f.cancel("12"))).toHaveLength(1);
  expect(f.store.get(a.id)?.cancelled).toBe(1);
  f.store.finish(a.id, a.token);
  expect(f.store.cancel(f.cancel("13"))).toEqual([]);
  f.store.release(a.id, a.token);
  expect(f.store.list()).toEqual([]);
  expect(() => f.store.admit(f.request, 105000)).toThrow("execution_position_stale");
});
it("keeps cancellation available while new admission is quarantined", () => {
  const f = fixture();
  f.store.admit(f.request, 105000);
  f.store.block();
  expect(f.store.cancel(f.cancel())).toHaveLength(1);
  expect(() => f.store.admit({ ...f.request, operationId: randomUUID() }, 105000)).toThrow(
    "runtime_quarantined",
  );
});
it("does not extend the original operation deadline after restart", () => {
  const f = fixture(),
    o = f.store.admit(f.request, 105000).operation;
  f.now(101001);
  f.reopen();
  expect(() => f.store.claim(o.id, o.token, 123, "start")).toThrow("operation_unavailable");
  expect(f.store.get(o.id)?.deadline).toBe(101000);
});
it("changes executor identity on VM boot and refuses old requests", () => {
  const f = fixture();
  f.store.admit(f.request, 105000);
  f.reopen(randomUUID());
  expect(f.store.bootId).not.toBe(f.request.bootId);
  expect(() => f.store.admit(f.request, 105000)).toThrow("executor_replaced");
});
it("retains exact Kafka offsets above JavaScript's safe integer range", () => {
  const f = fixture(),
    request = { ...f.request, source: { ...f.request.source, offset: "9007199254740993" } };
  f.store.admit(request, 105000);
  expect(() =>
    f.store.admit(
      {
        ...request,
        operationId: randomUUID(),
        source: { ...request.source, offset: "9007199254740992" },
      },
      105000,
    ),
  ).toThrow("execution_position_stale");
});
it("does not take over a live Guest service based on elapsed time", () => {
  const f = fixture();
  expect(f.store.own(123, "start", () => false)).toBe(true);
  f.now(999999);
  expect(f.store.own(124, "new", () => true)).toBe(false);
  expect(f.store.own(124, "new", () => false)).toBe(true);
});
