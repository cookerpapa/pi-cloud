import { afterEach, expect, it, vi } from "vitest";
import { createExecutionReference, type PathProbe } from "@pi-cloud/protocol";
import type { AcceptedFact } from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";
import { ToolReplyMailbox, toolReplyTopic } from "@pi-cloud/event-log";
afterEach(() => vi.useRealTimers());
async function fixture() {
  const facts: AcceptedFact[] = [];
  const log = new WorkerExecutionLog({
    append: async (fact) => {
      facts.push(fact);
      return { factId: fact.factId, durable: true };
    },
    checkHealth: async () => {},
  });
  const scope = toolInvocationFixture().scope;
  const reference = createExecutionReference(scope.leaseId, scope.runId, scope.fencingToken);
  const writer = await log.open({
    executionReference: reference,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    nextEventSeq: 1,
    piSession: { id: scope.piSessionId, conversationId: 1, writerId: scope.writerId },
    publication: { scope },
  });
  const { leaseId: _lease, piConversationId: _conversation, ...identity } = scope;
  const publish = () =>
    writer.commitNative({
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
  return { facts, log, scope, identity, reference, writer, publish };
}
it("does not accept maintenance as Session Kafka history", async () => {
  const f = await fixture();
  try {
    for (const kind of ["path_probe", "runtime_keepalive"])
      expect(() =>
        parseKafkaAcceptedFact(
          JSON.stringify({
            kind,
            factId: "probe",
            scope: f.identity,
            occurredAt: new Date().toISOString(),
          }),
        ),
      ).toThrow();
  } finally {
    await f.log.close();
  }
});
it("keeps silent families free of periodic Kafka publications", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  try {
    await f.publish();
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(f.facts.map((fact) => fact.kind)).toEqual(["durable_commit"]);
    expect(f.writer.acknowledgedThroughSeq).toBe(0);
  } finally {
    await f.log.close();
  }
});
it("coalesces fault checks and waits for a fresh reply and owner confirmation over HTTP", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    mailbox = new ToolReplyMailbox();
  const requests: PathProbe[] = [],
    owner = Promise.withResolvers<boolean>(),
    confirm = vi.fn(() => owner.promise);
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    report: vi.fn(),
    confirm,
    partitionFor: () => 0,
    request: async (value) => {
      requests.push(value);
      return true;
    },
  });
  try {
    const binding = crypto.randomUUID();
    await f.publish();
    f.log.bindRuntime(f.reference, binding);
    const first = f.log.confirmExecution(f.reference, binding, 1, new AbortController().signal);
    const second = f.log.confirmExecution(f.reference, binding, 1, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    const probe = requests[0]!;
    mailbox.accept({
      kind: "execution_probe",
      probeId: probe.factId,
      sentAt: Date.parse(probe.occurredAt),
      guestBootId: "guest",
      bindingIds: [binding],
      evidence: { bindingId: binding, targetId: "target", bootId: "boot", observedAt: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledOnce();
    let done = false;
    void first.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    owner.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.facts).toHaveLength(1);
    expect(mailbox.size).toBe(0);
  } finally {
    owner.resolve(false);
    mailbox.close();
    await f.log.close();
  }
});
it.each(["lost_reply", "lost_http_ack", "changed_binding", "stop", "closing_writer"])(
  "does not turn %s into readiness or writer revocation",
  async (fault) => {
    vi.useFakeTimers();
    const f = await fixture(),
      mailbox = new ToolReplyMailbox(),
      sent: PathProbe[] = [];
    const acknowledgement = Promise.withResolvers<boolean>(),
      confirm = vi.fn(async () => true);
    f.log.configureExecutionProbes({
      topic: toolReplyTopic(crypto.randomUUID()),
      replies: mailbox,
      report: vi.fn(),
      confirm,
      partitionFor: () => 0,
      request: async (value) => {
        sent.push(value);
        return fault === "lost_http_ack" ? acknowledgement.promise : true;
      },
    });
    try {
      const binding = crypto.randomUUID(),
        abort = new AbortController();
      await f.publish();
      f.log.bindRuntime(f.reference, binding);
      const ready = f.log.confirmExecution(f.reference, binding, 1, abort.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (fault === "changed_binding") f.log.bindRuntime(f.reference, crypto.randomUUID());
      if (fault === "stop") abort.abort();
      if (fault === "closing_writer") await f.writer.close();
      await vi.advanceTimersByTimeAsync(10000);
      expect(await ready).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      expect(f.writer.failureSignal?.aborted).toBe(false);
      acknowledgement.resolve(true);
      const probe = sent[0]!;
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
      acknowledgement.resolve(false);
      mailbox.close();
      await f.log.close();
    }
  },
);
it("passively registers the owned current-Worker receiver before execution-side dispatch", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    mailbox = new ToolReplyMailbox(),
    report = vi.fn();
  const topic = toolReplyTopic(crypto.randomUUID());
  f.log.configureExecutionProbes({
    topic,
    replies: mailbox,
    report,
    confirm: async () => true,
    request: async () => true,
    partitionFor: () => 0,
  });
  try {
    const binding = crypto.randomUUID();
    await f.publish();
    f.log.bindRuntime(f.reference, binding);
    const request: PathProbe = {
      kind: "path_probe",
      factId: crypto.randomUUID(),
      scope: f.identity,
      occurredAt: new Date().toISOString(),
      execution: {
        replyTopic: topic,
        bindings: [{ scope: f.identity, bindingId: binding, probe: true }],
      },
    };
    expect(() =>
      f.log.receiveProbe({ ...request, scope: { ...f.identity, writerId: crypto.randomUUID() } }),
    ).toThrow();
    expect(f.log.receiveProbe(request)).toBe(topic);
    mailbox.accept({
      kind: "execution_probe",
      probeId: request.factId,
      sentAt: Date.parse(request.occurredAt),
      guestBootId: "guest",
      bindingIds: [binding],
      evidence: { bindingId: binding, targetId: "target", bootId: "boot", observedAt: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    expect(f.facts).toHaveLength(1);
  } finally {
    mailbox.close();
    await f.log.close();
  }
});
