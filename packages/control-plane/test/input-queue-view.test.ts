import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { InputQueueChange, InputQueueResource } from "@pi-cloud/protocol";
import { InputQueueView } from "../src/input-queue-view.ts";
import { ControlPlaneStoreError } from "../src/control-plane-store-error.ts";

function fixture() {
  const tenant = randomUUID(),
    session = randomUUID();
  const value = (viewVersion: string): InputQueueResource => ({
    sessionId: session,
    revision: 1,
    viewVersion,
    activeTurnId: null,
    items: [],
  });
  const read = vi.fn(async () => value("2")),
    publish = vi.fn(),
    unavailable = vi.fn();
  const watched = vi.fn(() => true);
  const view = new InputQueueView({ read, publish, unavailable, watched });
  const change = (version: string): InputQueueChange => ({
    kind: "control_change",
    factId: randomUUID(),
    scope: { tenantId: tenant, piSessionId: session },
    entity: "input_queue",
    entityId: session,
    version,
    occurredAt: new Date().toISOString(),
  });
  return { tenant, session, value, read, publish, unavailable, watched, view, change };
}

it("reads on a watched change and coalesces older notifications covered by the snapshot", async () => {
  const f = fixture();
  await f.view.consume(f.change("1"), () => true);
  await f.view.consume(f.change("2"), () => true);
  for (let i = 0; i < 100; i++) expect(f.view.current(f.tenant, f.session)?.viewVersion).toBe("2");
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.tenant, f.value("2"));
});

it("does not read or retain an unobserved queue and does not share tenants", async () => {
  const f = fixture();
  f.watched.mockReturnValue(false);
  await f.view.consume(f.change("1"), () => true);
  expect(f.read).not.toHaveBeenCalled();
  f.watched.mockReturnValue(true);
  await f.view.consume(f.change("1"), () => true);
  expect(f.view.current(randomUUID(), f.session)).toBeUndefined();
  f.watched.mockReturnValue(false);
  await f.view.consume(f.change("2"), () => true);
  expect(f.view.current(f.tenant, f.session)).toBeUndefined();
});

it("discards a delayed snapshot after reset or ownership loss", async () => {
  const f = fixture(),
    pending = Promise.withResolvers<InputQueueResource>();
  f.read.mockImplementationOnce(() => pending.promise);
  const work = f.view.consume(f.change("1"), () => true);
  f.view.reset();
  pending.resolve(f.value("2"));
  await work;
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.view.current(f.tenant, f.session)).toBeUndefined();
});

it("never lets an older concurrent SQL snapshot overwrite a newer version", async () => {
  const f = fixture(),
    pending = Promise.withResolvers<InputQueueResource>();
  f.read.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(f.value("3"));
  const old = f.view.consume(f.change("1"), () => true);
  await f.view.consume(f.change("3"), () => true);
  pending.resolve(f.value("2"));
  await old;
  expect(f.view.current(f.tenant, f.session)?.viewVersion).toBe("3");
  expect(f.publish).toHaveBeenCalledOnce();
});

it("resynchronizes a removed conversation and rejects an inconsistent snapshot", async () => {
  const f = fixture();
  await f.view.consume(f.change("1"), () => true);
  f.read.mockRejectedValueOnce(new ControlPlaneStoreError("not_found", "removed"));
  await f.view.consume(f.change("3"), () => true);
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith(f.tenant, f.session);
  expect(f.view.current(f.tenant, f.session)).toBeUndefined();
  await expect(f.view.consume(f.change("4"), () => true)).rejects.toThrow("behind");
});
