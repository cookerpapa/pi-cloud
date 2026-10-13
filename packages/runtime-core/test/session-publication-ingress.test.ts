import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { SessionControlChange } from "@pi-cloud/protocol";
import {
  SessionPublicationIngress,
  type PublicationRecord,
} from "../src/session-publication-ingress.ts";
function change(sessionId: string = randomUUID(), version = "1"): SessionControlChange {
  return {
    kind: "control_change",
    factId: randomUUID(),
    entity: "sandbox_binding",
    scope: { tenantId: randomUUID(), piSessionId: sessionId },
    entityId: randomUUID(),
    runId: randomUUID(),
    version,
    closed: false,
    occurredAt: new Date().toISOString(),
  };
}
function fixture(capacity?: { maximumPendingBytes: number; maximumPendingFacts: number }) {
  const records: PublicationRecord[] = [];
  const gates: Array<Promise<void>> = [];
  const writer = {
    append: vi.fn(async (record: PublicationRecord) => {
      records.push(record);
      await gates.shift();
      return { factId: record.factId, durable: true as const };
    }),
    close: vi.fn(async () => {}),
  };
  const ingress = new SessionPublicationIngress(capacity);
  const owner = ingress.installPartition(0, writer);
  return { ingress, owner, writer, records, gates };
}
it("orders one Session's control changes while unrelated Sessions continue", async () => {
  const f = fixture(),
    gate = Promise.withResolvers<void>();
  const a = change(),
    b = { ...change(a.scope.piSessionId, "2"), scope: a.scope };
  f.gates.push(gate.promise);
  const first = f.ingress.control(f.owner, a);
  const second = f.ingress.control(f.owner, b);
  await vi.waitFor(() => expect(f.records).toHaveLength(1));
  await f.ingress.control(f.owner, change());
  expect(f.records).toHaveLength(2);
  gate.resolve();
  await Promise.all([first, second]);
  expect(f.records.map((r) => r.factId)).toEqual([a.factId, f.records[1]!.factId, b.factId]);
  expect(f.ingress.statistics()).toEqual({ pendingBytes: 0, pendingFacts: 0 });
  await f.ingress.close();
});
it("bounds pending control bytes and releases capacity after failure", async () => {
  const f = fixture({ maximumPendingBytes: 10000, maximumPendingFacts: 1 }),
    gate = Promise.withResolvers<void>();
  f.gates.push(gate.promise);
  const first = f.ingress.control(f.owner, change());
  expect(() => f.ingress.control(f.owner, change())).toThrow("capacity");
  gate.resolve();
  await first;
  f.writer.append.mockRejectedValueOnce(new Error("ACK unknown"));
  await expect(f.ingress.control(f.owner, change())).rejects.toThrow("ACK unknown");
  await expect(f.ingress.control(f.owner, change())).resolves.toMatchObject({ durable: true });
  expect(f.ingress.statistics().pendingFacts).toBe(0);
  await f.ingress.close();
});
it("rejects queued controls and stale owners after assignment replacement", async () => {
  const f = fixture(),
    gate = Promise.withResolvers<void>(),
    a = change();
  f.gates.push(gate.promise);
  const first = f.ingress.control(f.owner, a);
  const queued = f.ingress.control(f.owner, { ...a, factId: randomUUID(), version: "2" });
  void queued.catch(() => {});
  await vi.waitFor(() => expect(f.records).toHaveLength(1));
  await f.ingress.revoke(0);
  const owner = f.ingress.installPartition(0, f.writer);
  expect(() => f.ingress.control(f.owner, change())).toThrow("not_owner");
  gate.resolve();
  await first;
  await expect(queued).rejects.toThrow("not_owner");
  await f.ingress.control(owner, change());
  expect(f.records).toHaveLength(2);
  await f.ingress.close();
});
it("has no Worker registration, data append or child seal authority", async () => {
  const f = fixture();
  for (const name of ["installRun", "append", "seal", "beginAdmission"])
    expect(name in f.ingress).toBe(false);
  await f.ingress.control(f.owner, change());
  await f.ingress.close();
});
