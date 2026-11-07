import type { Database } from "@pi-cloud/database";
import type { Kysely, Transaction } from "kysely";
import type { SupervisorHeartbeatMessage, SupervisorHeartbeatAckMessage } from "@pi-cloud/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { PostgresSessionLeaseObserver } from "../src/postgres-session-lease-observer.ts";

const identity = (id = "lease") => ({
  tenantId: "tenant",
  piSessionId: id + "-session",
  leaseId: id,
  writerId: id,
  fencingToken: 1,
});
const row = (id = "lease", remaining_ms = "1000") => ({
  tenant_id: "tenant",
  pi_session_id: id + "-session",
  lease_id: id,
  fencing_token: "1",
  remaining_ms,
});
const observers: PostgresSessionLeaseObserver[] = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  let now = 1000;
  const lookup = vi.fn().mockResolvedValue([row()]);
  const query = {
    select() {
      return this;
    },
    where: vi.fn(function () {
      return query;
    }),
    execute: lookup,
  };
  const database = { selectFrom: () => query } as unknown as Kysely<Database>;
  const observer = new PostgresSessionLeaseObserver({
    database,
    monotonicNow: () => now,
  });
  observers.push(observer);
  const authority = observer.open(identity());
  return {
    observer,
    authority,
    lookup,
    query,
    transaction: database as Transaction<Database>,
    advance: (value: number) => {
      now = value;
    },
  };
}
function renewal(
  f: ReturnType<typeof fixture>,
  requestedAt: number,
  ids = [identity()],
  renewed = ids.map((i) => i.leaseId),
  deferred: string[] = [],
) {
  const heartbeat = {
    messageId: "heartbeat",
    payload: { connectionId: "connection", families: ids },
  } as SupervisorHeartbeatMessage;
  const ack = {
    sentAt: new Date(0).toISOString(),
    payload: {
      acknowledgedMessageId: "heartbeat",
      connectionId: "connection",
      familyLeaseDeferrals: deferred.map((leaseId) => ({ leaseId, fencingToken: 1 })),
      familyLeaseRenewals: renewed.map((leaseId) => ({
        leaseId,
        fencingToken: 1,
        validUntil: new Date(60000).toISOString(),
      })),
    },
  } as SupervisorHeartbeatAckMessage;
  f.observer.observeRenewals(heartbeat, ack, requestedAt);
}

it("refreshes an expired observation after slow cold restore without revoking a renewed owner", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  await f.authority.assertCurrent();
  expect(f.lookup).toHaveBeenCalledTimes(1);
  f.advance(2500);
  f.lookup.mockResolvedValue([row("lease", "1500")]);
  await f.authority.assertCurrent();
  expect(f.lookup).toHaveBeenCalledTimes(2);
  expect(f.authority.signal.aborted).toBe(false);
});

it("revokes an owner when the fresh lookup rejects it", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  f.advance(2500);
  f.lookup.mockResolvedValue([]);
  await expect(f.authority.assertCurrent()).rejects.toThrow("stale ExecutionReference");
  expect(f.authority.signal.aborted).toBe(true);
});

it("does not extend a lease observation by time spent receiving it", async () => {
  const f = fixture();
  f.lookup.mockImplementation(async () => {
    f.advance(2500);
    return [row()];
  });
  await expect(f.authority.assertCurrent()).rejects.toThrow("stale ExecutionReference");
  expect(f.authority.signal.aborted).toBe(true);
});

it("does not use wall-clock jumps to expire a cached observation", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  vi.spyOn(Date, "now").mockReturnValue(0);
  await f.authority.assertCurrent();
  vi.spyOn(Date, "now").mockReturnValue(9e15);
  await f.authority.assertCurrent();
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("coalesces cold opens and uses only direct renewals throughout a long management outage", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    second = f.observer.open(identity("second")),
    third = f.observer.open(identity("third"));
  f.lookup.mockResolvedValue([
    row("lease", "10000"),
    row("second", "10000"),
    row("third", "10000"),
  ]);
  await Promise.all([f.authority.assertCurrent(), second.assertCurrent(), third.assertCurrent()]);
  expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(f.query.where).toHaveBeenCalledWith("lease_id", "in", ["lease", "second", "third"]);
  for (const a of [f.authority, second, third]) a.start();
  const ids = [identity(), identity("second"), identity("third")];
  renewal(f, 1000, ids);
  // Five minutes without registration/management traffic. PG renewals are the
  // only new authority evidence; the observer performs no one-second SELECTs.
  for (let now = 21000; now <= 301000; now += 20000) {
    f.advance(now);
    await vi.advanceTimersByTimeAsync(20000);
    renewal(f, now, ids);
    for (const a of [f.authority, second, third]) a.assertActive();
  }
  expect(f.authority.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(third.signal.aborted).toBe(false);
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("learns silent PG revocation at the next direct renewal without an independent polling path", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.authority.assertCurrent();
  f.authority.start();
  renewal(f, 1000);
  f.lookup.mockResolvedValue([]);
  f.advance(20000);
  await vi.advanceTimersByTimeAsync(19000);
  f.authority.assertActive();
  expect(f.lookup).toHaveBeenCalledTimes(1);
  renewal(f, 21000, [identity()], []);
  expect(f.authority.signal.aborted).toBe(true);
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("a newer committed heartbeat wins over an older in-flight negative read", async () => {
  const f = fixture();
  let resolve!: (rows: unknown[]) => void;
  f.lookup.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const checking = f.authority.assertCurrent();
  await Promise.resolve();
  f.advance(1100);
  renewal(f, 1100);
  resolve([]);
  await checking;
  expect(f.authority.signal.aborted).toBe(false);
});

it("a stale heartbeat cannot overwrite a newer PG observation", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  renewal(f, 500, [identity()], []);
  await f.authority.assertCurrent();
  expect(f.authority.signal.aborted).toBe(false);
});

it("missing renewal revokes only its reported family and cannot be revived", async () => {
  const f = fixture(),
    second = f.observer.open(identity("second"));
  f.lookup.mockResolvedValue([row(), row("second")]);
  await Promise.all([f.authority.assertCurrent(), second.assertCurrent()]);
  renewal(f, 1100, [identity()], []);
  expect(f.authority.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  renewal(f, 1200);
  await expect(f.authority.assertCurrent()).rejects.toThrow();
});

it.each(["tenantId", "piSessionId", "writerId", "fencingToken"] as const)(
  "rejects a mismatched %s in a batch result",
  async (field) => {
    const f = fixture();
    const other = f.observer.open({
      ...identity(),
      [field]: field === "fencingToken" ? 2 : "wrong",
    });
    await expect(other.assertCurrent()).rejects.toThrow("stale ExecutionReference");
    await f.authority.assertCurrent();
    expect(f.authority.signal.aborted).toBe(false);
  },
);

it("fails all affected observers on a PG read error", async () => {
  const f = fixture(),
    second = f.observer.open(identity("second"));
  f.lookup.mockRejectedValue(new Error("database unavailable"));
  await expect(f.authority.assertCurrent()).rejects.toThrow("database unavailable");
  expect(f.authority.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
});

it("does not apply a late query to a closed or newly opened observer", async () => {
  const f = fixture();
  let resolve!: (rows: unknown[]) => void;
  f.lookup.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = f.authority.assertCurrent();
  const failure = expect(pending).rejects.toThrow("closed");
  await Promise.resolve();
  await f.authority.close();
  const replacement = f.observer.open(identity());
  const fresh = replacement.assertCurrent();
  resolve([]);
  await failure;
  await fresh;
  expect(replacement.signal.aborted).toBe(false);
  expect(f.lookup).toHaveBeenCalledTimes(2);
});

it("does not seed a reopened handle from a renewal requested before that handle existed", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  await f.authority.close();
  f.advance(2000);
  const replacement = f.observer.open(identity());
  renewal(f, 1100);
  f.lookup.mockResolvedValue([]);
  await expect(replacement.assertCurrent()).rejects.toThrow("stale ExecutionReference");
  expect(f.lookup).toHaveBeenCalledTimes(2);
});

it("expires active authority while PG is stalled and rejects late renewal revival", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.lookup.mockResolvedValueOnce([row("lease", "3000")]);
  await f.authority.assertCurrent();
  f.authority.start();
  const response = Promise.withResolvers<unknown[]>();
  f.lookup.mockImplementation(() => response.promise);
  f.advance(2000);
  const pending = f.authority.assertCurrent(f.transaction);
  const rejected = expect(pending).rejects.toThrow("lifetime expired");
  expect(f.lookup).toHaveBeenCalledTimes(2);
  // Last confirmation at 1000 + 3000. A busy read cannot hold this deadline.
  f.advance(4000);
  await vi.advanceTimersByTimeAsync(3000);
  await rejected;
  expect(f.authority.signal.aborted).toBe(true);
  await expect(f.authority.assertCurrent()).rejects.toThrow("lifetime expired");
  renewal(f, 4500);
  expect(f.authority.signal.aborted).toBe(true);
  await f.observer.close(); // Does not wait for the outstanding response.
  response.resolve([row("lease", "60000")]);
  await Promise.resolve();
  expect(f.authority.signal.aborted).toBe(true);
});

it("synchronously expires an active owner after event-loop delay rather than refreshing it", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  f.authority.start();
  f.advance(2500);
  expect(() => f.authority.assertActive()).toThrow("lifetime expired");
  await expect(f.authority.assertCurrent()).rejects.toThrow("lifetime expired");
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("a fresh renewal moves the deadline without letting an old pending read revoke it", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.lookup.mockResolvedValueOnce([row("lease", "5000")]);
  await f.authority.assertCurrent();
  f.authority.start();
  const response = Promise.withResolvers<unknown[]>();
  f.lookup.mockImplementation(() => response.promise);
  f.advance(2000);
  const pending = f.authority.assertCurrent(f.transaction);
  f.advance(2500);
  renewal(f, 2500);
  f.advance(7000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.authority.signal.aborted).toBe(false);
  response.resolve([]);
  await pending;
  await f.authority.assertCurrent();
  expect(f.authority.signal.aborted).toBe(false);
});

it("cold admission never refreshes or revokes an unrelated active owner", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  f.authority.start();
  const cold = f.observer.open(identity("new"));
  f.lookup.mockResolvedValue([row("new")]);
  await cold.assertCurrent();
  expect(f.query.where).toHaveBeenLastCalledWith("writer_sealed_at", "is", null);
  expect(f.query.where).toHaveBeenCalledWith("lease_id", "in", ["new"]);
  f.authority.assertActive();
  expect(() => cold.assertActive()).toThrow("not active");
});

it("requires fresh PG confirmation before activating a cold owner", () => {
  const f = fixture();
  expect(() => f.authority.start()).toThrow("no confirmed lease");
  expect(() => f.authority.assertActive()).toThrow("not active");
});

it("deferral neither revokes an eligible owner nor extends its confirmed lifetime", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.authority.assertCurrent();
  f.authority.start();
  f.advance(1500);
  renewal(f, 1500, [identity()], [], ["lease"]);
  expect(f.authority.signal.aborted).toBe(false);
  f.advance(2000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.authority.signal.aborted).toBe(true);
});

it("rejects foreign and overlapping deferrals before adopting any authority", async () => {
  const f = fixture();
  await f.authority.assertCurrent();
  expect(() => renewal(f, 1500, [identity()], [], ["foreign"])).toThrow("scope changed");
  expect(() => renewal(f, 1500, [identity()], ["lease"], ["lease"])).toThrow("scope changed");
  expect(f.authority.signal.aborted).toBe(false);
});

it("close interrupts a cold check without waiting for its PG read", async () => {
  const f = fixture();
  const response = Promise.withResolvers<unknown[]>();
  f.lookup.mockImplementation(() => response.promise);
  const check = f.authority.assertCurrent();
  const rejected = expect(check).rejects.toThrow("observer closed");
  await Promise.resolve();
  await f.observer.close();
  await rejected;
  response.resolve([row()]);
});
