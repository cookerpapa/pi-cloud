import { afterEach, expect, it, vi } from "vitest";
import { createExecutionReference } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type {
  AcceptedFact,
  AcceptedFactReceipt,
  ExecutionPublication,
} from "../src/accepted-fact.ts";
import { DirectExecutionLog } from "../src/direct-execution-log.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";

it("decodes only the bounded content-free probe protocol", () => {
  const { leaseId: _lease, piSessionLane: _lane, ...scope } = toolInvocationFixture().scope;
  const probe = {
    kind: "path_probe",
    factId: "probe",
    scope,
    occurredAt: new Date().toISOString(),
  };
  expect(parseKafkaAcceptedFact(JSON.stringify(probe))).toEqual(probe);
  expect(() =>
    parseKafkaAcceptedFact(JSON.stringify({ ...probe, arguments: "PRIVATE" })),
  ).toThrow();
  expect(() =>
    parseKafkaAcceptedFact(JSON.stringify({ ...probe, occurredAt: "invalid timestamp here" })),
  ).toThrow();
});

afterEach(() => vi.useRealTimers());
function fixture(append: (fact: AcceptedFact) => Promise<AcceptedFactReceipt>) {
  const writes = vi.fn(async () => []);
  const query = {
    set() {
      return this;
    },
    where() {
      return this;
    },
    execute: writes,
  };
  const log = new DirectExecutionLog(
    { updateTable: () => query } as unknown as Kysely<Database>,
    { append, checkHealth: async () => {} },
    undefined,
    15_000,
  );
  const base = toolInvocationFixture().scope;
  async function open(scope: ExecutionPublication["scope"]) {
    const executionReference = createExecutionReference(
      scope.leaseId,
      scope.runId,
      scope.fencingToken,
    );
    const writer = await log.open({
      executionReference,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      nextEventSeq: 1,
      piSession: { id: scope.piSessionId, lane: scope.piSessionLane, writerId: scope.writerId },
      publication: { scope },
    });
    const publish = () =>
      writer.mutate({
        schemaVersion: 1,
        mutationId: crypto.randomUUID(),
        scope: { ...scope, executionReference },
        occurredAt: new Date().toISOString(),
        items: [],
        events: [],
      });
    return { writer, publish };
  }
  return { log, writes, base, open };
}

it("probes a quiet physical Session once across Lanes and never opens or sequences history", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "performance"] });
  const facts: AcceptedFact[] = [];
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  try {
    const a = await f.open(f.base);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(facts).toHaveLength(0);
    const b = await f.open({
      ...f.base,
      runId: "20000000-0000-4000-8000-000000000099",
      piSessionLane: "child",
    });
    await b.publish(); // first registered Lane is still unpublished
    await vi.advanceTimersByTimeAsync(15_000);
    expect(facts.map((f) => f.kind)).toEqual(["pi_session_append", "path_probe"]);
    expect(facts[1]?.scope.writerId).toBe(f.base.writerId);
    expect(a.writer.acknowledgedThroughSeq).toBe(0);
    expect(b.writer.acknowledgedThroughSeq).toBe(0);
    expect(f.writes).not.toHaveBeenCalled();
    await a.publish();
    await vi.advanceTimersByTimeAsync(10_000);
    await b.publish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(facts.filter((f) => f.kind === "path_probe")).toHaveLength(1);
    await a.writer.close();
    await b.writer.close();
    const length = facts.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(facts).toHaveLength(length);
  } finally {
    await f.log.close();
  }
});

it("bounds stalled probes and a lost probe ACK does not poison later semantic writes", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "performance"] });
  const ack = Promise.withResolvers<AcceptedFactReceipt>();
  const append = vi.fn(async (fact: AcceptedFact) =>
    fact.kind === "path_probe" ? ack.promise : { factId: fact.factId, durable: true as const },
  );
  const f = fixture(append);
  try {
    const a = await f.open(f.base);
    await a.publish();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(append).toHaveBeenCalledTimes(2);
    await expect(a.publish()).resolves.toMatchObject({ accepted: true });
    await a.writer.close(); // draining semantics does not wait for the probe receipt
    ack.reject(new Error("Probe ACK lost"));
    await vi.advanceTimersByTimeAsync(0);
    const b = await f.open({ ...f.base, runId: "20000000-0000-4000-8000-000000000088" });
    await expect(b.publish()).resolves.toMatchObject({ accepted: true });
  } finally {
    ack.reject(new Error("closed"));
    await f.log.close();
  }
});
