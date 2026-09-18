import { it, expect, vi } from "vitest";
import { PostgresPiWorker } from "../src/postgres-pi-worker.ts";
import type {
  RunExecutor,
  RunClaimAdmission,
  RunClaimReference,
} from "@pi-cloud/runtime-core/run-executor";
import type { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";

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

it("drains owned families by admitting their children, without admitting another family", async () => {
  const emptyQuery = {
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
    execute: async () => [],
  };
  const database = { selectFrom: () => emptyQuery } as unknown as Kysely<Database>;
  const job = (piSessionId: string) => {
    let release!: () => void;
    const completion = new Promise<void>((r) => (release = r));
    return { runId: crypto.randomUUID(), tenantId: "tenant", piSessionId, completion, release };
  };
  const parent = job("a"),
    child = job("a"),
    foreign = job("b");
  const queue = [parent],
    started: string[] = [];
  let probes = 0,
    peak = 0;
  const executor = {
    dispatchNext: async (
      admission: RunClaimAdmission,
      onClaimed: (ref: RunClaimReference) => void,
    ) => {
      peak = Math.max(peak, ++probes);
      await Promise.resolve();
      probes--;
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
      await next.completion;
      return { status: "completed" };
    },
  } as unknown as RunExecutor;
  const worker = new PostgresPiWorker({
    database,
    notificationConnectionString: "test",
    identity: "worker",
    maximumActiveFamilies: 1,
    maximumLanesPerFamily: 4,
    memoryHeadroom: () => true,
    pollIntervalMs: 10,
    runExecutor: executor,
    cancellationExecutor: {} as RunCancellationExecutor,
  });
  await worker.start();
  try {
    await vi.waitFor(() => expect(started).toContain(parent.runId));
    const draining = worker.stop();
    queue.push(child, foreign);
    worker.scheduleOwnedSubagent(child.runId);
    await vi.waitFor(() => expect(started).toContain(child.runId));
    expect(started).not.toContain(foreign.runId);
    child.release();
    parent.release();
    await draining;
    expect(queue).toEqual([foreign]);
    expect(peak).toBeLessThanOrEqual(2);
  } finally {
    parent.release();
    child.release();
    foreign.release();
    await worker.stop();
  }
});
