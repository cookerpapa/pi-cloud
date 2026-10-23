import { afterEach, expect, it, vi } from "vitest";
import { createExecutionReference } from "@pi-cloud/protocol";
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

it("keeps silent native families alive without changing native sequence or suppressing diagnostics", async () => {
  vi.useFakeTimers();
  const facts: AcceptedFact[] = [];
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  const root = await f.open(f.base);
  try {
    f.log.bindRetention(root.executionReference, 1, {
      workspaceId: "10000000-0000-4000-8000-000000000001",
    });
    await root.publish();
    await vi.advanceTimersByTimeAsync(15001);
    const renewal = facts.find((fact) => fact.kind === "runtime_keepalive");
    expect(renewal).toBeDefined();
    expect(parseKafkaAcceptedFact(JSON.stringify(renewal))).toEqual(renewal);
    expect(facts.some((fact) => fact.kind === "path_probe")).toBe(true);
    // Model silence can outlast several retention windows. It needs no token
    // delta or extra native commit to keep producing fresh bounded intents.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(facts.filter((fact) => fact.kind === "durable_commit")).toHaveLength(1);
    const delivered = facts.filter((fact) => fact.kind === "runtime_keepalive").length;
    expect(delivered).toBeGreaterThanOrEqual(122);
    f.log.bindRetention(root.executionReference, 1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(facts.filter((fact) => fact.kind === "runtime_keepalive")).toHaveLength(delivered);
  } finally {
    await f.log.close();
  }
});
function fixture(append: (fact: AcceptedFact) => Promise<AcceptedFactReceipt>) {
  const log = new WorkerExecutionLog({ append, checkHealth: async () => {} }, undefined, 15_000);
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
  return { log, base, open };
}

it("splits all child retention references without per-child writers or truncation", async () => {
  vi.useFakeTimers();
  const facts: AcceptedFact[] = [];
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  const root = await f.open(f.base);
  try {
    for (let n = 1; n <= 70; n++)
      f.log.bindRetention(root.executionReference, n, {
        workspaceId: "10000000-0000-4000-8000-000000000001",
        computeSessionId: crypto.randomUUID(),
      });
    await root.publish();
    await vi.advanceTimersByTimeAsync(0);
    const messages = facts.filter((fact) => fact.kind === "runtime_keepalive");
    expect(messages).toHaveLength(2);
    expect(messages.flatMap((fact) => fact.resources)).toHaveLength(70);
    expect(new Set(messages.map((fact) => fact.scope.writerId)).size).toBe(1);
    for (const message of messages)
      expect(parseKafkaAcceptedFact(JSON.stringify(message))).toEqual(message);
    await root.writer.close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(facts.filter((fact) => fact.kind === "runtime_keepalive")).toHaveLength(2);
  } finally {
    await f.log.close();
  }
});

it("coalesces fault probes, awaits owner validation and adds no native history or Tool callback", async () => {
  vi.useFakeTimers();
  const facts: AcceptedFact[] = [],
    mailbox = new ToolReplyMailbox();
  const owner = Promise.withResolvers<boolean>(),
    confirm = vi.fn(() => owner.promise);
  const f = fixture(async (fact) => {
    facts.push(fact);
    return { factId: fact.factId, durable: true };
  });
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    report: vi.fn(),
    confirm,
    partitionFor: () => 0,
  });
  try {
    const a = await f.open(f.base),
      binding = crypto.randomUUID();
    await a.publish();
    f.log.bindRuntime(a.executionReference, binding);
    const first = f.log.confirmExecution(
      a.executionReference,
      binding,
      1,
      new AbortController().signal,
    );
    const second = f.log.confirmExecution(
      a.executionReference,
      binding,
      1,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const probe = facts.at(-1) as Extract<AcceptedFact, { kind: "path_probe" }>;
    expect(facts.map((f) => f.kind)).toEqual(["durable_commit", "path_probe"]);
    expect(mailbox.size).toBe(0);
    mailbox.accept({
      kind: "execution_probe",
      probeId: probe.factId,
      sentAt: Date.parse(probe.occurredAt),
      guestBootId: crypto.randomUUID(),
      bindingIds: [binding],
      evidence: { bindingId: binding, targetId: "target", bootId: "boot", observedAt: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledOnce();
    let finished = false;
    void first.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    owner.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(a.writer.acknowledgedThroughSeq).toBe(0);
  } finally {
    mailbox.close();
    await f.log.close();
  }
});

it.each(["lost_reply", "lost_publication_ack", "changed_binding", "stop", "closing_writer"])(
  "ends a fault probe without granting readiness: %s",
  async (fault) => {
    vi.useFakeTimers();
    const facts: AcceptedFact[] = [],
      mailbox = new ToolReplyMailbox();
    const ack = Promise.withResolvers<AcceptedFactReceipt>();
    const f = fixture(async (fact) => {
      facts.push(fact);
      return fault === "lost_publication_ack" && fact.kind === "path_probe"
        ? ack.promise
        : { factId: fact.factId, durable: true };
    });
    const confirm = vi.fn(async () => true);
    f.log.configureExecutionProbes({
      topic: toolReplyTopic(crypto.randomUUID()),
      replies: mailbox,
      report: vi.fn(),
      confirm,
      partitionFor: () => 0,
    });
    try {
      const a = await f.open(f.base),
        binding = crypto.randomUUID(),
        stop = new AbortController();
      await a.publish();
      f.log.bindRuntime(a.executionReference, binding);
      const ready = f.log.confirmExecution(a.executionReference, binding, 1, stop.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (fault === "changed_binding") f.log.bindRuntime(a.executionReference, crypto.randomUUID());
      if (fault === "stop") stop.abort();
      if (fault === "closing_writer") await a.writer.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await ready).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      const probe = facts.find(
        (f): f is Extract<AcceptedFact, { kind: "path_probe" }> => f.kind === "path_probe",
      )!;
      ack.resolve({ factId: probe.factId, durable: true });
      mailbox.accept({
        kind: "execution_probe",
        probeId: probe.factId,
        sentAt: Date.parse(probe.occurredAt),
        guestBootId: "guest",
        bindingIds: [binding],
        evidence: {
          bindingId: binding,
          targetId: "target",
          bootId: "boot",
          observedAt: Date.now(),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      mailbox.close();
      await f.log.close();
    }
  },
);

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
    const b = f.log.openConversation(a.executionReference, {
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      conversationId: 2,
      nextEventSeq: 1,
    });
    await a.publish(); // All Conversations publish through the physical writer.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(facts.map((f) => f.kind)).toEqual(["durable_commit", "path_probe"]);
    expect(facts[1]?.scope.writerId).toBe(f.base.writerId);
    expect(a.writer.acknowledgedThroughSeq).toBe(0);
    expect(b.acknowledgedThroughSeq).toBe(0);
    await a.publish();
    await vi.advanceTimersByTimeAsync(10_000);
    await a.publish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(facts.filter((f) => f.kind === "path_probe")).toHaveLength(1);
    await b.close();
    await a.writer.close();
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
    confirm: async () => true,
  });
  try {
    const childSessionId = crypto.randomUUID();
    const a = await f.open(f.base);
    const b = f.log.openConversation(a.executionReference, {
      sessionId: childSessionId,
      turnId: crypto.randomUUID(),
      conversationId: 2,
      nextEventSeq: 1,
    });
    await a.publish();
    await vi.advanceTimersByTimeAsync(15000);
    expect(facts.filter((f) => f.kind === "path_probe").at(-1)).toMatchObject({
      execution: { bindings: [] },
    });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    f.log.bindRuntime(a.executionReference, ids[0]);
    f.log.bindRuntime(a.executionReference, ids[1], 2);
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
    expect(report.mock.calls.map(([r]) => r.scope.runId)).toEqual([f.base.runId, f.base.runId]);
    expect(report.mock.calls.map(([r]) => r.scope.sessionId)).toEqual([
      f.base.sessionId,
      childSessionId,
    ]);
    expect(a.writer.acknowledgedThroughSeq).toBe(0);
    await b.close();
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
    confirm: async () => true,
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
