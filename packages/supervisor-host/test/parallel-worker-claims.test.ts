import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
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

type Ticket = {
  admission: RunClaimAdmission;
  claim(family: string): void;
  finish(): void;
  fail(): void;
};
const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

function fixture(capacity = 4, lanes = 4, readiness = async () => true) {
  const tickets: Ticket[] = [];
  let accepting = true;
  const empty = {
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
  const failure = vi.fn();
  const worker = new PostgresPiWorker({
    database: { selectFrom: () => empty } as unknown as Kysely<Database>,
    notificationConnectionString: "test",
    identity: "worker",
    maximumActiveFamilies: capacity,
    maximumLanesPerFamily: lanes,
    memoryHeadroom: () => true,
    pollIntervalMs: 10_000,
    canClaimRuns: () => accepting,
    admitRunClaims: readiness,
    onFailure: failure,
    cancellationExecutor: {} as RunCancellationExecutor,
    runExecutor: {
      dispatchNext(admission: RunClaimAdmission, onClaimed: (r: RunClaimReference) => void) {
        const done = Promise.withResolvers<{ status: "idle" }>();
        const runId = crypto.randomUUID();
        tickets.push({
          admission,
          claim: (piSessionId) => onClaimed({ runId, tenantId: "tenant", piSessionId }),
          finish: () => done.resolve({ status: "idle" }),
          fail: () => done.reject(new Error("injected failure")),
        });
        return done.promise;
      },
    } as unknown as RunExecutor,
  });
  const close = async () => {
    accepting = false;
    for (const t of tickets) t.finish();
    await worker.stop();
  };
  closing.push(close);
  return { worker, tickets, failure, close };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("caps pending claims at two, then replenishes at commit rather than Agent completion", async () => {
  const f = fixture();
  await f.worker.start();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(2));
  for (let n = 0; n < 100; n++) f.worker.scheduleOwnedSubagent("hint");
  await tick();
  expect(f.tickets).toHaveLength(2);
  f.tickets[0]!.claim("a");
  await vi.waitFor(() => expect(f.tickets).toHaveLength(3));
  expect(f.tickets[2]!.admission.allowedFamilyKeys).toBeUndefined();
});

it("reserves unknown claims against family capacity and the last available Lane", async () => {
  const f = fixture(1, 2);
  await f.worker.start();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(1));
  f.tickets[0]!.claim("a");
  await vi.waitFor(() => expect(f.tickets).toHaveLength(2));
  expect(f.tickets[1]!.admission.allowedFamilyKeys).toEqual(["tenant:a"]);
  f.tickets[1]!.claim("a");
  await tick();
  expect(f.tickets).toHaveLength(2);
  f.tickets[1]!.finish();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(3));
  expect(f.tickets[2]!.admission.allowedFamilyKeys).toEqual(["tenant:a"]);
});

it("idle and failed claims release their reservations without a self-waking retry loop", async () => {
  const f = fixture();
  await f.worker.start();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(2));
  f.tickets[0]!.finish();
  f.tickets[1]!.fail();
  await tick();
  await tick();
  expect(f.tickets).toHaveLength(2);
  expect(f.failure).toHaveBeenCalledTimes(1);
  f.worker.scheduleOwnedSubagent("external-wake");
  await vi.waitFor(() => expect(f.tickets).toHaveLength(4));
});

it("an execution failure after claim confirmation does not release another pending slot", async () => {
  const f = fixture();
  await f.worker.start();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(2));
  f.tickets[0]!.claim("a");
  await vi.waitFor(() => expect(f.tickets).toHaveLength(3));
  f.tickets[0]!.fail();
  await tick();
  for (let n = 0; n < 20; n++) f.worker.scheduleOwnedSubagent("hint");
  await tick();
  expect(f.tickets).toHaveLength(3);
});

it("shutdown joins already-issued claims and limits later probes to owned families", async () => {
  const f = fixture();
  await f.worker.start();
  await vi.waitFor(() => expect(f.tickets).toHaveLength(2));
  let stopped = false;
  const stop = f.worker.stop().then(() => {
    stopped = true;
  });
  await tick();
  expect(stopped).toBe(false);
  expect(f.tickets).toHaveLength(2);
  f.tickets[0]!.claim("a");
  await vi.waitFor(() => expect(f.tickets).toHaveLength(3));
  expect(f.tickets[2]!.admission.allowedFamilyKeys).toEqual(["tenant:a"]);
  await f.close();
  await stop;
  expect(stopped).toBe(true);
});

it("does not start claims after shutdown while readiness was pending", async () => {
  const ready = Promise.withResolvers<boolean>();
  const entered = vi.fn(() => ready.promise);
  const f = fixture(4, 4, entered);
  await f.worker.start();
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  const stop = f.worker.stop();
  ready.resolve(true);
  await stop;
  expect(f.tickets).toHaveLength(0);
});
