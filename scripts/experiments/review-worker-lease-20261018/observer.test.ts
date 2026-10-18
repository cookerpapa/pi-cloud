// Baseline characterizations, not repaired-behavior regression tests.
import { expect, it, vi } from "vitest";
import { PostgresSessionLeaseObserver } from "../../../packages/pi-session-postgres/src/postgres-session-lease-observer.ts";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";

it("characterizes a stalled PG observation beyond the last confirmed local deadline", async () => {
  vi.useFakeTimers();
  let now = 0;
  const reply = Promise.withResolvers<unknown[]>();
  const read = vi
    .fn()
    .mockResolvedValueOnce([
      {
        tenant_id: "tenant",
        pi_session_id: "session",
        lease_id: "lease",
        fencing_token: "1",
        remaining_ms: "3000",
      },
    ])
    .mockImplementation(() => reply.promise);
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    execute: read,
  };
  const observer = new PostgresSessionLeaseObserver({
    database: { selectFrom: () => query } as unknown as Kysely<Database>,
    monotonicNow: () => now,
  });
  const owner = observer.open({
    tenantId: "tenant",
    piSessionId: "session",
    leaseId: "lease",
    writerId: "lease",
    fencingToken: 1,
  });
  try {
    await owner.assertCurrent();
    owner.start();
    now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    now = 10_000;
    await vi.advanceTimersByTimeAsync(9000);
    let settled = false;
    const check = owner.assertCurrent().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    process.stdout.write(
      JSON.stringify({
        probe: "observer-pending",
        deadline: 3000,
        observedAt: now,
        aborted: false,
        newAuthorityCheck: "pending",
      }) + "\n",
    );
    reply.resolve([]);
    await check;
    expect(owner.signal.aborted).toBe(true);
  } finally {
    reply.resolve([]);
    await observer.close();
    vi.useRealTimers();
  }
});
