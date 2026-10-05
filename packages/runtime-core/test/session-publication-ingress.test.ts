import { randomUUID } from "node:crypto";
import { MAX_EXECUTION_FACT_BYTES, type SessionControlChange } from "@pi-cloud/protocol";
import { expect, it, vi } from "vitest";
import type {
  AcceptedExecutionSealFact,
  AcceptedDurableCommitFact,
  ExecutionPublication,
} from "../src/accepted-fact.ts";
import {
  SessionPublicationIngress,
  type PartitionPublicationWriter,
  type PublicationRecord,
} from "../src/session-publication-ingress.ts";

const deferred = <T>() => Promise.withResolvers<T>();
function permit(
  epoch = 7,
  prior?: ExecutionPublication,
  run = randomUUID(),
  lane = 1,
): ExecutionPublication {
  const writer = prior && prior.scope.fencingToken === epoch ? prior.scope.writerId : randomUUID();
  return {
    scope: {
      tenantId: prior?.scope.tenantId ?? randomUUID(),
      sessionId: randomUUID(),
      piSessionId: prior?.scope.piSessionId ?? randomUUID(),
      runId: run,
      turnId: randomUUID(),
      writerId: writer,
      leaseId: writer,
      fencingToken: epoch,
      piConversationId: lane,
    },
  };
}
function entry(p: ExecutionPublication, text = "accepted"): AcceptedDurableCommitFact {
  const { leaseId: _lease, piConversationId, ...scope } = p.scope;
  return {
    kind: "durable_commit",
    factId: randomUUID(),
    scope,
    commit: {
      seq: 1,
      nextId: 3,
      writes: [
        {
          type: "entry",
          value: { id: 2, conversationId: piConversationId, kind: "test", data: { text } },
        },
      ],
    },
    origins: [
      { recordId: 2, runId: scope.runId, sessionId: scope.sessionId, turnId: scope.turnId },
    ],
    tools: [],
    cancellations: [],
    events: [],
    occurredAt: new Date().toISOString(),
  };
}
function seal(p: ExecutionPublication, closesWriter = true): AcceptedExecutionSealFact {
  const { leaseId: _lease, piConversationId: _lane, ...scope } = p.scope;
  return {
    kind: "execution_seal",
    factId: randomUUID(),
    scope,
    closesWriter,
    agentId: "root",
    baseSequence: 0,
    terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
    occurredAt: new Date().toISOString(),
  };
}
function fixture(capacity?: { maximumPendingBytes: number; maximumPendingFacts: number }) {
  const records: PublicationRecord[] = [],
    gates: Array<ReturnType<typeof deferred<void>>> = [];
  const writer: PartitionPublicationWriter = {
    append: vi.fn<PartitionPublicationWriter["append"]>(async (record) => {
      records.push(record);
      const gate = gates.shift();
      if (gate) await gate.promise;
      return { factId: record.factId, durable: true };
    }),
    close: vi.fn(async () => {}),
  };
  const ingress = new SessionPublicationIngress(capacity);
  const owner = ingress.installPartition(0, writer);
  const p = permit();
  ingress.installRun(owner, p);
  return { ingress, owner, writer, p, records, gates };
}

function controlChange(p: ExecutionPublication, version: string): SessionControlChange {
  return {
    kind: "control_change",
    factId: randomUUID(),
    entity: "sandbox_binding",
    scope: { tenantId: p.scope.tenantId, piSessionId: p.scope.piSessionId },
    entityId: randomUUID(),
    runId: p.scope.runId,
    version,
    closed: false,
    occurredAt: new Date().toISOString(),
  };
}

it("orders control changes with native publications on the physical Session queue", async () => {
  const f = fixture(),
    gate = deferred<void>();
  f.gates.push(gate);
  const first = f.ingress.control(f.owner, controlChange(f.p, "1"));
  const native = f.ingress.append(f.owner, entry(f.p));
  const next = f.ingress.control(f.owner, controlChange(f.p, "2"));
  await vi.waitFor(() => expect(f.records).toHaveLength(1));
  gate.resolve();
  await Promise.all([first, native, next]);
  expect(f.records.map((r) => JSON.parse(r.value).kind)).toEqual([
    "control_change",
    "durable_commit",
    "control_change",
  ]);
  expect(new Set(f.records.map((r) => r.sessionId))).toEqual(new Set([f.p.scope.piSessionId]));
  expect(f.ingress.statistics()).toEqual({ pendingBytes: 0, pendingFacts: 0 });
});

it("accepts an authorized cold control change without opening a native writer", async () => {
  const f = fixture(),
    cold = permit();
  await f.ingress.control(f.owner, controlChange(cold, "1"));
  await expect(f.ingress.append(f.owner, entry(cold))).rejects.toMatchObject({
    reason: "not_open",
  });
  f.ingress.installRun(f.owner, cold);
  await f.ingress.append(f.owner, entry(cold));
  expect(f.records).toHaveLength(2);
});

it("keeps native publication independent of an uncertain idempotent control change", async () => {
  const f = fixture();
  vi.mocked(f.writer.append).mockRejectedValueOnce(new Error("Control ACK lost"));
  await expect(f.ingress.control(f.owner, controlChange(f.p, "1"))).rejects.toThrow("ACK lost");
  await expect(f.ingress.append(f.owner, entry(f.p))).resolves.toMatchObject({ durable: true });
});

it("closes admission before draining and emits the seal before opening a new writer", async () => {
  const f = fixture(),
    firstAck = deferred<void>(),
    sealAck = deferred<void>();
  f.gates.push(firstAck, sealAck);
  const first = f.ingress.append(f.owner, entry(f.p));
  await vi.waitFor(() => expect(f.records).toHaveLength(1));
  let closed = false;
  const sealing = f.ingress.seal(f.owner, seal(f.p)).then(() => {
    closed = true;
  });
  await expect(f.ingress.append(f.owner, entry(f.p, "late"))).rejects.toMatchObject({
    reason: "closed",
  });
  expect(f.records).toHaveLength(1);
  expect(closed).toBe(false);
  const next = permit(8, f.p);
  expect(() => f.ingress.installRun(f.owner, next)).toThrow("not_open");
  firstAck.resolve();
  await first;
  await vi.waitFor(() => expect(f.records).toHaveLength(2));
  expect(closed).toBe(false);
  sealAck.resolve();
  await sealing;
  f.ingress.installRun(f.owner, next);
  await f.ingress.append(f.owner, entry(next));
  expect(f.records.map((r) => JSON.parse(r.value).scope.fencingToken)).toEqual([7, 7, 8]);
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "not_open" });
  expect(f.ingress.statistics()).toEqual({ pendingFacts: 0, pendingBytes: 0 });
});

it("keeps sibling Lane publication open after normal Run closure", async () => {
  const f = fixture(),
    child = permit(7, f.p, randomUUID(), 2);
  f.ingress.installRun(f.owner, child);
  await f.ingress.seal(f.owner, seal(child, false));
  await expect(f.ingress.append(f.owner, entry(child))).rejects.toMatchObject({ reason: "closed" });
  await f.ingress.append(f.owner, entry(f.p));
  expect(f.records.map((r) => JSON.parse(r.value).kind)).toEqual([
    "execution_seal",
    "durable_commit",
  ]);
  await f.ingress.seal(f.owner, seal(f.p));
  const next = permit(8, f.p);
  f.ingress.installRun(f.owner, next);
});

it("allows a new lease after all normal Run seals without inventing a writer failure", async () => {
  const f = fixture();
  await f.ingress.seal(f.owner, seal(f.p, false));
  const next = permit(8, f.p);
  f.ingress.installRun(f.owner, next);
  await f.ingress.append(f.owner, entry(next));
});

it("deduplicates the same seal and rejects a conflicting seal identity", async () => {
  const f = fixture(),
    closing = seal(f.p);
  const first = await f.ingress.seal(f.owner, closing);
  expect(await f.ingress.seal(f.owner, closing)).toEqual(first);
  expect(f.records).toHaveLength(1);
  await expect(f.ingress.seal(f.owner, seal(f.p))).rejects.toMatchObject({ reason: "scope" });
  expect(() => f.ingress.installRun(f.owner, f.p)).toThrow("closed");
});

it("can close an execution that never opened its publication channel", async () => {
  const f = fixture(),
    p = permit();
  await f.ingress.seal(f.owner, seal(p));
  await expect(f.ingress.append(f.owner, entry(p))).rejects.toMatchObject({ reason: "closed" });
});

it("does not admit a larger epoch or an unknown Run directly from an append", async () => {
  const f = fixture();
  await expect(f.ingress.append(f.owner, entry(permit(8, f.p)))).rejects.toMatchObject({
    reason: "not_open",
  });
  const wrong = entry(f.p);
  Object.assign(wrong.scope, { fencingToken: 8 });
  await expect(f.ingress.append(f.owner, wrong)).rejects.toMatchObject({ reason: "scope" });
  expect(f.records).toEqual([]);
});

it("closes the whole writer on an uncertain semantic append without poisoning another Session", async () => {
  const f = fixture();
  vi.mocked(f.writer.append).mockRejectedValueOnce(new Error("commit reply lost"));
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toThrow("commit reply lost");
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "closed" });
  const other = permit();
  f.ingress.installRun(f.owner, other);
  await f.ingress.append(f.owner, entry(other));
  await f.ingress.seal(f.owner, seal(f.p));
});

it("bounds admission without revoking accepted work, and a failed seal enqueue still closes the Run", async () => {
  const f = fixture({ maximumPendingBytes: 1024 * 1024, maximumPendingFacts: 1 }),
    ack = deferred<void>();
  f.gates.push(ack);
  const writing = f.ingress.append(f.owner, entry(f.p));
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "capacity" });
  const closing = seal(f.p);
  await expect(f.ingress.seal(f.owner, closing)).rejects.toMatchObject({ reason: "capacity" });
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "closed" });
  ack.resolve();
  await writing;
  await f.ingress.seal(f.owner, closing);
  expect(f.records).toHaveLength(2);
});

it("invalidates slow admission continuations when partition ownership changes", async () => {
  const f = fixture();
  await f.ingress.revoke(0);
  const owner = f.ingress.installPartition(0, f.writer);
  expect(() => f.ingress.installRun(f.owner, f.p)).toThrow("not_owner");
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({
    reason: "not_owner",
  });
  await expect(f.ingress.append(owner, entry(f.p))).rejects.toMatchObject({ reason: "not_open" });
  f.ingress.installRun(owner, f.p);
  await f.ingress.append(owner, entry(f.p));
});

it("retains the accepted serialized payload even if its caller reuses the object", async () => {
  const f = fixture(),
    value = entry(f.p, "original");
  const pending = f.ingress.append(f.owner, value);
  Object.assign(value, { items: [] });
  await pending;
  expect(f.records[0]!.value).toContain("original");
  expect(f.records[0]!.value).not.toContain("mutated");
});

it("rejects a PG admission snapshot overtaken by a projected seal even without cached Run state", () => {
  const f = fixture(),
    p = permit();
  const admission = f.ingress.beginAdmission(f.owner, p.scope);
  f.ingress.confirmSealed(f.owner, seal(p));
  expect(() => f.ingress.installRun(f.owner, p, admission)).toThrow("not_open");
  admission.release();
});

it("does not repeat a Session admission read when unrelated Sessions open or seal", async () => {
  const f = fixture(),
    p = permit();
  const admission = f.ingress.beginAdmission(f.owner, p.scope);
  const other = permit();
  f.ingress.installRun(f.owner, other);
  await f.ingress.seal(f.owner, seal(other));
  f.ingress.installRun(f.owner, p, admission);
  admission.release();
  await f.ingress.append(f.owner, entry(p));
});

it("uses projected closure after a lost seal ACK without leaving the next writer blocked", async () => {
  const f = fixture(),
    closing = seal(f.p);
  vi.mocked(f.writer.append).mockRejectedValueOnce(new Error("seal ACK lost"));
  await expect(f.ingress.seal(f.owner, closing)).rejects.toThrow("seal ACK lost");
  expect(() => f.ingress.installRun(f.owner, permit(8, f.p))).toThrow("not_open");
  f.ingress.confirmSealed(f.owner, closing);
  const next = permit(8, f.p);
  f.ingress.installRun(f.owner, next);
  await f.ingress.append(f.owner, entry(next));
});

it("stops queued data after an uncertain append but still permits the closing seal", async () => {
  const f = fixture(),
    failed = deferred<never>();
  vi.mocked(f.writer.append).mockImplementationOnce(() => failed.promise);
  const first = f.ingress.append(f.owner, entry(f.p));
  const next = f.ingress.append(f.owner, entry(f.p));
  const results = Promise.allSettled([first, next]);
  failed.reject(new Error("commit uncertain"));
  expect((await results).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(f.writer.append).toHaveBeenCalledOnce();
  await f.ingress.seal(f.owner, seal(f.p));
  expect(f.writer.append).toHaveBeenCalledTimes(2);
});

it("rejects an oversized record without poisoning another Session's publication", async () => {
  const f = fixture();
  await expect(
    f.ingress.append(f.owner, entry(f.p, "x".repeat(MAX_EXECUTION_FACT_BYTES))),
  ).rejects.toMatchObject({ reason: "size" });
  const other = permit();
  f.ingress.installRun(f.owner, other);
  await f.ingress.append(f.owner, entry(other));
  await f.ingress.append(f.owner, entry(f.p));
  expect(f.records).toHaveLength(2);
});

it("bounds cached writers across partitions and evicts only fully sealed state", async () => {
  const f = fixture();
  const ingress = new SessionPublicationIngress(undefined, 1);
  const first = ingress.installPartition(0, f.writer),
    second = ingress.installPartition(1, f.writer);
  ingress.installRun(first, f.p);
  const other = permit();
  expect(() => ingress.installRun(second, other)).toThrow("capacity");
  await ingress.seal(first, seal(f.p));
  ingress.installRun(second, other);
  await expect(ingress.append(first, entry(f.p))).rejects.toMatchObject({ reason: "not_open" });
  await ingress.revoke(1);
  ingress.installRun(first, permit());
  await ingress.close();
});

it("closes execution before sealing without blocking another Session's publication", async () => {
  const f = fixture(),
    stopped = deferred<void>(),
    closing = seal(f.p),
    closeExecution = vi.fn(() => stopped.promise);
  const pending = f.ingress.seal(f.owner, closing, closeExecution);
  expect(f.ingress.seal(f.owner, closing, closeExecution)).toBe(pending);
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "closed" });
  const other = permit();
  f.ingress.installRun(f.owner, other);
  await f.ingress.append(f.owner, entry(other));
  expect(f.records.map((record) => JSON.parse(record.value).kind)).toEqual(["durable_commit"]);
  expect(closeExecution).toHaveBeenCalledOnce();
  stopped.resolve();
  await pending;
  expect(f.records.map((record) => JSON.parse(record.value).kind)).toEqual([
    "durable_commit",
    "execution_seal",
  ]);
});

it("retains closed admission when execution closure fails before logging its seal", async () => {
  const f = fixture(),
    closing = seal(f.p);
  await expect(
    f.ingress.seal(f.owner, closing, async () => {
      throw new Error("closure unconfirmed");
    }),
  ).rejects.toThrow("unconfirmed");
  expect(f.records).toEqual([]);
  await expect(f.ingress.append(f.owner, entry(f.p))).rejects.toMatchObject({ reason: "closed" });
  await f.ingress.seal(f.owner, closing, async () => {});
  expect(f.records).toHaveLength(1);
});
