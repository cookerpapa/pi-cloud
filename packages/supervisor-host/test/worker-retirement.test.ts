import { afterEach, expect, it, vi } from "vitest";
import { settleWorkerExecutions } from "../src/worker-retirement.ts";
afterEach(() => vi.useRealTimers());

it("allows natural drain without revoking a settled family", async () => {
  const retire = vi.fn(),
    waitAssignments = vi.fn(async () => {});
  await settleWorkerExecutions({
    stopClaimsAndJoin: async () => {},
    waitAssignments,
    retire,
    drainMs: 30,
    retirementMs: 100,
    allowDrain: true,
  });
  expect(retire).not.toHaveBeenCalled();
  expect(waitAssignments).toHaveBeenCalledOnce();
});

it("bounds natural drain then joins execution exit before returning proof", async () => {
  vi.useFakeTimers();
  const joined = Promise.withResolvers<void>(),
    exited = Promise.withResolvers<void>();
  const retire = vi.fn(() => joined.resolve());
  let finished = false;
  const pending = settleWorkerExecutions({
    stopClaimsAndJoin: () => joined.promise,
    waitAssignments: () => exited.promise,
    retire,
    drainMs: 30,
    retirementMs: 100,
    allowDrain: true,
  }).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(29);
  expect(retire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(retire).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  exited.resolve();
  await pending;
  expect(finished).toBe(true);
});

it("never confirms retirement when PG-backed settlement cannot finish", async () => {
  vi.useFakeTimers();
  const retire = vi.fn();
  const pending = settleWorkerExecutions({
    stopClaimsAndJoin: () => new Promise(() => {}),
    waitAssignments: async () => {},
    retire,
    drainMs: 30,
    retirementMs: 100,
    allowDrain: false,
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "worker_retirement_timeout" });
  expect(retire).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
});

it("revokes remaining admission when stopping the queue fails", async () => {
  const failure = new Error("database unavailable"),
    retire = vi.fn();
  await expect(
    settleWorkerExecutions({
      stopClaimsAndJoin: async () => {
        throw failure;
      },
      waitAssignments: async () => {},
      retire,
      drainMs: 30,
      retirementMs: 100,
      allowDrain: true,
    }),
  ).rejects.toBe(failure);
  expect(retire).toHaveBeenCalledOnce();
});
