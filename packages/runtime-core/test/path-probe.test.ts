import { afterEach, expect, it, vi } from "vitest";
import { createExecutionReference } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type {
  AcceptedFact,
  AcceptedFactReceipt,
  ExecutionPublication,
} from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";
import { ToolReplyMailbox, toolReplyTopic } from "@pi-cloud/event-log";

it("decodes only the bounded content-free probe protocol", () => {
  const { leaseId: _lease, piConversationId: _lane, ...scope } = toolInvocationFixture().scope;
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
  const log = new WorkerExecutionLog(
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
      piSession: {
        id: scope.piSessionId,
        conversationId: scope.piConversationId,
        writerId: scope.writerId,
      },
      publication: { scope },
    });
    const publish = () => {
      const { leaseId: _lease, piConversationId: _conversation, ...identity } = scope;
      return writer.commitNative({
        kind: "durable_commit",
        factId: crypto.randomUUID(),
        scope: identity,
        commit: { seq: 1, nextId: 2, writes: [] },
        origins: [],
        tools: [],
        cancellations: [],
        display: [],
        occurredAt: new Date().toISOString(),
      });
    };
    return { writer, publish, executionReference };
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
      piConversationId: 2,
    });
    await b.publish(); // first registered Lane is still unpublished
    await vi.advanceTimersByTimeAsync(15_000);
    expect(facts.map((f) => f.kind)).toEqual(["durable_commit", "path_probe"]);
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

it("probes bound guests despite ongoing text and aggregates Session bindings into one publication", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "performance"] });
  const facts: AcceptedFact[] = [],
    mailbox = new ToolReplyMailbox(),
    report = vi.fn();
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    partitionFor: () => 0,
    report,
  });
  try {
    const childRunId = crypto.randomUUID();
    const a = await f.open(f.base),
      b = await f.open({ ...f.base, runId: childRunId, piConversationId: 2 });
    await a.publish();
    await b.publish();
    await vi.advanceTimersByTimeAsync(15000);
    expect(facts.filter((f) => f.kind === "path_probe").at(-1)).toMatchObject({
      execution: { bindings: [] },
    });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    f.log.bindRuntime(a.executionReference, ids[0]);
    f.log.bindRuntime(b.executionReference, ids[1]);
    await vi.advanceTimersByTimeAsync(14000);
    await a.publish();
    await vi.advanceTimersByTimeAsync(1000);
    const probe = facts
      .filter((f): f is Extract<AcceptedFact, { kind: "path_probe" }> => f.kind === "path_probe")
      .at(-1)!;
    expect(probe.execution?.bindings.map((b) => b.bindingId)).toEqual(ids);
    expect(probe.execution?.bindings.every((b) => b.probe)).toBe(true);
    mailbox.accept({
      kind: "execution_probe",
      probeId: probe.factId,
      sentAt: Date.parse(probe.occurredAt),
      guestBootId: crypto.randomUUID(),
      bindingIds: ids,
      evidence: {
        bindingId: ids[0]!,
        targetId: "target",
        bootId: crypto.randomUUID(),
        observedAt: Date.now(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.map(([r]) => r.scope.runId)).toEqual([f.base.runId, childRunId]);
    expect(f.writes).not.toHaveBeenCalled();
    expect(a.writer.acknowledgedThroughSeq).toBe(0);
  } finally {
    mailbox.close();
    await f.log.close();
  }
});

it("lost guest replies do not stop log probes, and replacement rejects old binding replies", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "performance"] });
  const facts: AcceptedFact[] = [],
    mailbox = new ToolReplyMailbox(),
    report = vi.fn();
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    partitionFor: () => 0,
    report,
  });
  try {
    const a = await f.open(f.base);
    await a.publish();
    const old = crypto.randomUUID();
    f.log.bindRuntime(a.executionReference, old);
    await vi.advanceTimersByTimeAsync(15000);
    const first = facts.filter(
      (f): f is Extract<AcceptedFact, { kind: "path_probe" }> => f.kind === "path_probe",
    )[0]!;
    await vi.advanceTimersByTimeAsync(15000);
    expect(facts.filter((f) => f.kind === "path_probe")).toHaveLength(2);
    f.log.bindRuntime(a.executionReference, crypto.randomUUID());
    mailbox.accept({
      kind: "execution_probe",
      probeId: first.factId,
      sentAt: Date.parse(first.occurredAt),
      guestBootId: crypto.randomUUID(),
      bindingIds: [old],
      evidence: {
        bindingId: old,
        targetId: "target",
        bootId: crypto.randomUUID(),
        observedAt: Date.now(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).not.toHaveBeenCalled();
    await a.publish();
    expect(f.writes).not.toHaveBeenCalled();
  } finally {
    mailbox.close();
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
    await expect(a.publish()).resolves.toBeUndefined();
    await a.writer.close(); // draining semantics does not wait for the probe receipt
    ack.reject(new Error("Probe ACK lost"));
    await vi.advanceTimersByTimeAsync(0);
    const b = await f.open({ ...f.base, runId: "20000000-0000-4000-8000-000000000088" });
    await expect(b.publish()).resolves.toBeUndefined();
  } finally {
    ack.reject(new Error("closed"));
    await f.log.close();
  }
});
