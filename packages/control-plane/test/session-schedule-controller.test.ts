import { afterEach, expect, it, vi } from "vitest";
import { PostgresQueueWake } from "@pi-cloud/database";
import { SessionScheduleController } from "../src/session-schedule-controller.ts";
const active: SessionScheduleController[] = [];
afterEach(async () => {
  for (const c of active.splice(0)) await c.close();
});
function fixture(fallbackMs = 60000) {
  const wake = new PostgresQueueWake();
  let next: Date | null = new Date(Date.now() + 10000);
  const nextWake = vi.fn(async () => ({ now: new Date(), next }));
  const dispatchDue = vi.fn(async () => {
    next = null;
    return { examined: 1, admitted: 1, advanced: 1 };
  });
  const controller = new SessionScheduleController({
    service: { nextWake, dispatchDue },
    wake,
    fallbackMs,
  });
  active.push(controller);
  return {
    wake,
    controller,
    nextWake,
    dispatchDue,
    due: () => {
      next = new Date(Date.now() - 1);
    },
  };
}
it("waits for a future deadline without one-second polling and reacts to an earlier edit", async () => {
  const f = fixture();
  f.controller.start();
  await vi.waitFor(() => expect(f.nextWake).toHaveBeenCalledOnce());
  await new Promise((r) => setTimeout(r, 80));
  expect(f.nextWake).toHaveBeenCalledOnce();
  f.due();
  for (let i = 0; i < 100; i++) f.wake.notify();
  await vi.waitFor(() => expect(f.dispatchDue).toHaveBeenCalledOnce());
  expect(f.nextWake.mock.calls.length).toBeLessThan(6);
});
it("rechecks persistent due state after a missing notification", async () => {
  const f = fixture(60);
  f.controller.start();
  await vi.waitFor(() => expect(f.nextWake).toHaveBeenCalledOnce());
  f.due();
  await vi.waitFor(() => expect(f.dispatchDue).toHaveBeenCalledOnce());
});
it("backs off on contended rows and coalesces change bursts", async () => {
  const f = fixture(1000);
  f.due();
  f.dispatchDue.mockImplementation(async () => ({ examined: 1, admitted: 0, advanced: 0 }));
  f.controller.start();
  await vi.waitFor(() => expect(f.dispatchDue).toHaveBeenCalledOnce());
  for (let i = 0; i < 100; i++) f.wake.notify();
  await new Promise((r) => setTimeout(r, 90));
  expect(f.dispatchDue.mock.calls.length).toBeLessThanOrEqual(3);
});
it("does not enter admission while the Control Plane publication hold is active", async () => {
  const wake = new PostgresQueueWake();
  let held = true;
  const dispatchDue = vi.fn(async () => ({ examined: 1, admitted: 1, advanced: 1 }));
  let next: Date | null = new Date(Date.now() - 1);
  const c = new SessionScheduleController({
    wake,
    canDispatch: () => !held,
    service: {
      nextWake: async () => ({ now: new Date(), next }),
      dispatchDue: async () => {
        next = null;
        return dispatchDue();
      },
    },
  });
  active.push(c);
  c.start();
  await new Promise((r) => setTimeout(r, 60));
  expect(dispatchDue).not.toHaveBeenCalled();
  held = false;
  wake.notify();
  await vi.waitFor(() => expect(dispatchDue).toHaveBeenCalledOnce());
});
