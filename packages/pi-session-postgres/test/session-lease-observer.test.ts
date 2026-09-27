import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
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
  const observer = new PostgresSessionLeaseObserver({
    database: { selectFrom: () => query } as unknown as Kysely<Database>,
    monotonicNow: () => now,
  });
  observers.push(observer);
  const authority = observer.open(identity());
  return {
    observer,
    authority,
    lookup,
    query,
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

it("coalesces cold opens and one-second watches into one query per Worker", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    second = f.observer.open(identity("second")),
    third = f.observer.open(identity("third"));
  f.lookup.mockResolvedValue([row(), row("second"), row("third")]);
  await Promise.all([f.authority.assertCurrent(), second.assertCurrent(), third.assertCurrent()]);
  expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(f.query.where).toHaveBeenCalledWith("lease_id", "in", ["lease", "second", "third"]);
  for (const a of [f.authority, second, third]) a.start();
  f.advance(2000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lookup).toHaveBeenCalledTimes(2);
  f.lookup.mockResolvedValue([row(), row("third")]);
  f.advance(3000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(second.signal.aborted).toBe(true);
  expect(f.authority.signal.aborted).toBe(false);
  expect(third.signal.aborted).toBe(false);
  expect(f.lookup).toHaveBeenCalledTimes(3);
});

it("shares fresh renewal evidence without extending the one-second revocation window", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.authority.assertCurrent();
  f.authority.start();
  f.advance(1500);
  await vi.advanceTimersByTimeAsync(500);
  renewal(f, 1500);
  f.lookup.mockResolvedValue([]);
  f.advance(2000);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lookup).toHaveBeenCalledTimes(1);
  f.advance(2500);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.lookup).toHaveBeenCalledTimes(2);
  expect(f.authority.signal.aborted).toBe(true);
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
