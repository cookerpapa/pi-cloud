import { expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type {
  RunExecutor,
  RunClaimAdmission,
  RunClaimReference,
} from "@pi-cloud/runtime-core/run-executor";
import type { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import { PostgresPiWorker } from "../src/postgres-pi-worker.ts";

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      async connect() {}
      async query() {}
      async end() {}
    },
  };
});

it.each([false, true])(
  "keeps free families progressing and joins cancellation on shutdown (failure=%s)",
  async (fails) => {
    const job = (piSessionId: string) => ({
      runId: crypto.randomUUID(),
      tenantId: "tenant",
      piSessionId,
      done: Promise.withResolvers<void>(),
    });
    const first = job("a"),
      second = job("b");
    const queue = [first],
      started: string[] = [];
    const cancelling = Promise.withResolvers<void>();
    let cancellationPending = false,
      scans = 0;
    const query = {
      innerJoin() {
        return this;
      },
      select() {
        return this;
      },
      where() {
        return this;
      },
      limit() {
        return this;
      },
      execute: async () => {
        scans++;
        return cancellationPending
          ? [{ targetRunId: first.runId }, { targetRunId: first.runId }]
          : [];
      },
    };
    const executor = {
      dispatchNext: async (
        admission: RunClaimAdmission,
        onClaimed: (r: RunClaimReference) => void,
      ) => {
        await Promise.resolve();
        const index = queue.findIndex(
          (j) =>
            !admission.blockedFamilyKeys.includes(`tenant:${j.piSessionId}`) &&
            (admission.allowedFamilyKeys === undefined ||
              admission.allowedFamilyKeys.includes(`tenant:${j.piSessionId}`)),
        );
        if (index < 0) return { status: "idle" };
        const next = queue.splice(index, 1)[0]!;
        onClaimed(next);
        started.push(next.runId);
        await next.done.promise;
        return { status: "completed" };
      },
    } as unknown as RunExecutor;
    const cancel = vi.fn(async () => {
      await cancelling.promise;
      cancellationPending = false;
      if (fails) throw new Error("Cancellation settlement failed");
      return { status: "cancelled" };
    });
    const onFailure = vi.fn();
    const worker = new PostgresPiWorker({
      database: { selectFrom: () => query } as unknown as Kysely<Database>,
      notificationConnectionString: "test",
      identity: "worker",
      maximumActiveFamilies: 2,
      maximumLanesPerFamily: 4,
      memoryHeadroom: () => true,
      pollIntervalMs: 10,
      runExecutor: executor,
      cancellationExecutor: { dispatchTargetRun: cancel } as unknown as RunCancellationExecutor,
      onFailure,
    });
    await worker.start();
    try {
      await vi.waitFor(() => expect(started).toContain(first.runId));
      cancellationPending = true;
      worker.scheduleOwnedSubagent(first.runId);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      const before = scans;
      queue.push(second);
      worker.scheduleOwnedSubagent(second.runId);
      await vi.waitFor(() => expect(started).toContain(second.runId));
      await vi.waitFor(() => expect(scans).toBeGreaterThan(before + 1));
      expect(cancel).toHaveBeenCalledTimes(1);
      first.done.resolve();
      second.done.resolve();
      let stopped = false;
      const stop = worker.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      cancelling.resolve();
      await stop;
      expect(worker.state).toBe("stopped");
      expect(onFailure).toHaveBeenCalledTimes(fails ? 1 : 0);
    } finally {
      first.done.resolve();
      second.done.resolve();
      cancelling.resolve();
      await worker.stop();
    }
  },
);
