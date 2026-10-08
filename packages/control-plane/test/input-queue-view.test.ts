import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { InputQueueChange, InputQueueResource } from "@pi-cloud/protocol";
import { InputQueueView } from "../src/input-queue-view.ts";
import { ControlPlaneStoreError } from "../src/control-plane-store-error.ts";

function fixture(options: { concurrency?: number; maximumQueues?: number } = {}) {
  const tenant = randomUUID(),
    session = randomUUID();
  const value = (viewVersion: string, sessionId: string = session): InputQueueResource => ({
    sessionId,
    revision: `${"a".repeat(64)}.${"b".repeat(64)}`,
    viewVersion,
    activeTurnId: null,
    hasReturnedInputs: false,
    afterPosition: 0,
    hasMore: false,
    items: [],
  });
  const read = vi.fn(async (_tenant: string, target: string) => value("2", target));
  const publish = vi.fn(),
    unavailable = vi.fn(),
    onError = vi.fn();
  const watched = vi.fn(() => true);
  const view = new InputQueueView({ ...options, read, publish, unavailable, watched, onError });
  const change = (version: string, entityId = session): InputQueueChange => ({
    kind: "control_change",
    factId: randomUUID(),
    scope: { tenantId: tenant, piSessionId: entityId },
    entity: "input_queue",
    entityId,
    version,
    occurredAt: new Date().toISOString(),
  });
  return { tenant, session, value, read, publish, unavailable, watched, onError, view, change };
}

it("coalesces notifications already covered by the current snapshot", async () => {
  const f = fixture();
  f.view.consume(f.change("1"), () => true);
  f.view.consume(f.change("2"), () => true);
  await f.view.settle();
  for (let i = 0; i < 100; i++) expect(f.view.current(f.tenant, f.session)?.viewVersion).toBe("2");
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.tenant, f.value("2"));
});

it("does not await slow presentation reads or block another watched Session", async () => {
  const f = fixture(),
    pending = Promise.withResolvers<InputQueueResource>();
  f.read.mockImplementationOnce(() => pending.promise);
  expect(f.view.consume(f.change("1"), () => true)).toBeUndefined();
  const other = randomUUID();
  f.view.consume(f.change("1", other), () => true);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith(f.tenant, f.value("2", other)));
  expect(f.view.current(f.tenant, f.session)).toBeUndefined();
  pending.resolve(f.value("2"));
  await f.view.close();
});

it("bounds outstanding reads through reset and resynchronizes capacity overflow", async () => {
  const f = fixture({ concurrency: 1, maximumQueues: 1 });
  const pending = Promise.withResolvers<InputQueueResource>();
  f.read.mockImplementationOnce(() => pending.promise);
  f.view.consume(f.change("1"), () => true);
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  f.view.reset();
  const second = randomUUID(),
    overflow = randomUUID();
  f.view.consume(f.change("1", second), () => true);
  f.view.consume(f.change("1", overflow), () => true);
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.unavailable).toHaveBeenCalledWith(f.tenant, overflow);
  pending.resolve(f.value("2"));
  await f.view.settle();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.tenant, f.value("2", second));
});

it("does not read or retain unwatched queues and isolates tenants", async () => {
  const f = fixture();
  f.watched.mockReturnValue(false);
  f.view.consume(f.change("1"), () => true);
  await f.view.settle();
  expect(f.read).not.toHaveBeenCalled();
  f.watched.mockReturnValue(true);
  f.view.consume(f.change("1"), () => true);
  await f.view.settle();
  expect(f.view.current(randomUUID(), f.session)).toBeUndefined();
  f.watched.mockReturnValue(false);
  f.view.consume(f.change("2"), () => true);
  expect(f.view.current(f.tenant, f.session)).toBeUndefined();
});

it("coalesces changes arriving during a read and never publishes an obsolete snapshot", async () => {
  const f = fixture(),
    pending = Promise.withResolvers<InputQueueResource>();
  f.read.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(f.value("50"));
  f.view.consume(f.change("1"), () => true);
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  for (let version = 2; version <= 50; version++)
    f.view.consume(f.change(String(version)), () => true);
  pending.resolve(f.value("2"));
  await f.view.settle();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.tenant, f.value("50"));
});

it.each([new ControlPlaneStoreError("not_found", "removed"), new Error("SQL timeout")])(
  "resynchronizes on a failed read without rejecting ordered consumption (%s)",
  async (error) => {
    const f = fixture();
    f.read.mockRejectedValueOnce(error);
    f.view.consume(f.change("1"), () => true);
    await f.view.settle();
    expect(f.unavailable).toHaveBeenCalledWith(f.tenant, f.session);
    f.view.consume(f.change("4"), () => true);
    await f.view.settle();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledTimes(1);
  },
);
