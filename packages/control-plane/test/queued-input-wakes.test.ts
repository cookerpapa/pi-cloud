import { expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { QueuedInputService } from "../src/queued-input-service.ts";

function scheduledFixture() {
  const reads: string[] = [];
  const rows = vi.fn(async (_from: string): Promise<unknown[]> => []);
  const delay = vi.fn((): string | null => null);
  const database = {
    selectFrom(from: string) {
      const query = new Proxy(
        {},
        {
          get(_t, method) {
            if (method === "execute")
              return async () => {
                reads.push(from);
                return rows(from);
              };
            if (method === "executeTakeFirstOrThrow")
              return async () => {
                reads.push("deadline");
                return { delay: delay(), held: 1 };
              };
            return () => query;
          },
        },
      );
      return query;
    },
  } as unknown as Kysely<Database>;
  const service = new QueuedInputService({
    database,
    steering: { deliverQueued: async () => {} },
    autoStart: true,
  });
  return { reads, rows, delay, service };
}

it("retains one wake arriving during an in-flight Session read", async () => {
  vi.useFakeTimers();
  const f = scheduledFixture(),
    pending = Promise.withResolvers<unknown[]>();
  try {
    f.service.onModuleInit();
    void f.service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
    await vi.advanceTimersByTimeAsync(0);
    f.rows.mockImplementationOnce(() => pending.promise);
    f.service.notifySession("tenant", "session", true);
    for (let i = 0; i < 10; i++) f.service.notifySession("tenant", "session", true);
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.reads.filter((s) => s === "runs as r")).toHaveLength(2);
    expect(f.reads).toHaveLength(5);
  } finally {
    pending.resolve([]);
    await f.service.onApplicationShutdown();
    vi.useRealTimers();
  }
});

it("waits for a known retry deadline without polling the database each tick", async () => {
  vi.useFakeTimers();
  const f = scheduledFixture();
  try {
    f.service.onModuleInit();
    void f.service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
    await vi.advanceTimersByTimeAsync(0);
    f.delay.mockReturnValueOnce("5000");
    f.service.notifySession("tenant", "session", true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.reads).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.reads).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.reads).toHaveLength(5);
  } finally {
    await f.service.onApplicationShutdown();
    vi.useRealTimers();
  }
});

it("rechecks recovery requested while an earlier bootstrap was reading", async () => {
  vi.useFakeTimers();
  const f = scheduledFixture(),
    pending = Promise.withResolvers<unknown[]>();
  f.rows.mockImplementationOnce(() => pending.promise);
  try {
    f.service.onModuleInit();
    void f.service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
    f.service.recoverPending();
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.reads).toEqual(["runs as held", "runs as held"]);
  } finally {
    pending.resolve([]);
    await f.service.onApplicationShutdown();
    vi.useRealTimers();
  }
});

it("performs no idle database polling after recovery and checks only a notified Session", async () => {
  vi.useFakeTimers();
  const reads: Array<Array<unknown[]>> = [];
  const database = {
    selectFrom() {
      const predicates: unknown[][] = [];
      const query = new Proxy(
        {},
        {
          get(_target, method) {
            if (method === "execute" || method === "executeTakeFirstOrThrow")
              return async () => {
                reads.push(predicates);
                return method === "execute" ? [] : { delay: null, held: 0 };
              };
            return (...args: unknown[]) => {
              if (method === "where") predicates.push(args);
              return query;
            };
          },
        },
      );
      return query;
    },
  } as unknown as Kysely<Database>;
  const service = new QueuedInputService({
    database,
    steering: { deliverQueued: async () => {} },
    autoStart: true,
  });
  try {
    service.onModuleInit();
    void service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(reads).toHaveLength(1);
    service.notifySession("tenant", "ordinary");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toHaveLength(1);
    service.notifySession("tenant", "session", true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(reads).toHaveLength(3);
    for (const query of reads.slice(1)) {
      expect(query).toContainEqual(["r.tenant_id", "=", "tenant"]);
      expect(query).toContainEqual(["r.session_id", "=", "session"]);
    }
    service.notifySession("tenant", "session");
    await vi.advanceTimersByTimeAsync(60000);
    expect(reads).toHaveLength(3);
  } finally {
    await service.onApplicationShutdown();
    vi.useRealTimers();
  }
});

it("retains acknowledged held scopes until PG absence, and rejects an old bootstrap after reset", async () => {
  vi.useFakeTimers();
  const f = scheduledFixture();
  try {
    f.service.onModuleInit();
    f.rows.mockResolvedValueOnce([{ tenant_id: "tenant", session_id: "session" }]);
    await f.service.recoverPending({ partitionCount: 2, partitions: [1], current: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.reads).toHaveLength(3);
    f.service.notifySession("tenant", "session");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reads).toHaveLength(5);
    const slow = Promise.withResolvers<unknown[]>();
    f.rows.mockReturnValueOnce(slow.promise);
    const recovering = f.service.recoverPending({
      partitionCount: 2,
      partitions: [1],
      current: () => true,
    });
    f.service.reset();
    slow.resolve([{ tenant_id: "tenant", session_id: "obsolete" }]);
    await recovering;
    f.service.notifySession("tenant", "obsolete");
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.reads).toHaveLength(6);
  } finally {
    await f.service.onApplicationShutdown();
    vi.useRealTimers();
  }
});
