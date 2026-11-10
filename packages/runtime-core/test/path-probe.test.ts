import { afterEach, expect, it, vi } from "vitest";
import {
  createExecutionReference,
  PublicationNotSentError,
  type PathProbe,
} from "@pi-cloud/protocol";
import type { AcceptedFact } from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";
import { ToolReplyMailbox, toolReplyTopic } from "@pi-cloud/event-log";
afterEach(() => vi.useRealTimers());
it("retires the whole writer after uncertain Session activity publication", async () => {
  vi.useFakeTimers();
  const f = await fixture({ workspaceId: "used" }, (fact) => {
    if (fact.kind === "session_activity") throw new Error("producer fenced");
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writer.failureSignal?.aborted).toBe(true);
  await expect(f.publish()).rejects.toThrow("fenced");
  await f.log.close();
});
it("defers definitely unsent activity without disabling native publication", async () => {
  vi.useFakeTimers();
  let first = true;
  const f = await fixture({ workspaceId: "used" }, (fact) => {
    if (first && fact.kind === "session_activity") {
      first = false;
      throw new PublicationNotSentError("full before enqueue");
    }
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writer.failureSignal?.aborted).toBe(false);
    await f.publish();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.facts.at(-1)?.kind).toBe("session_activity");
  } finally {
    await f.log.close();
  }
});
async function fixture(
  resourceUse?: { workspaceId: string },
  onAppend?: (fact: AcceptedFact) => void,
) {
  const facts: AcceptedFact[] = [];
  const log = new WorkerExecutionLog({
    append: async (fact) => {
      facts.push(fact);
      onAppend?.(fact);
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
    ...(resourceUse ? { resourceUse } : {}),
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
it("rejects obsolete keepalive and incomplete Session activity envelopes", async () => {
  const f = await fixture();
  try {
    for (const kind of ["session_activity", "runtime_keepalive"])
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
it("publishes bounded Session activity during silent model waits without advancing native or display sequence", async () => {
  vi.useFakeTimers();
  const f = await fixture({ workspaceId: crypto.randomUUID() });
  try {
    await f.publish();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(f.facts.filter((x) => x.kind === "session_activity")).toHaveLength(4);
    expect(f.facts.filter((x) => x.kind === "durable_commit")).toHaveLength(1);
    expect(f.writer.acknowledgedThroughSeq).toBe(0);
    await f.writer.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.facts.filter((x) => x.kind === "session_activity")).toHaveLength(4);
  } finally {
    await f.log.close();
  }
});
it("uses one physical writer for child resource activity and removes settled children", async () => {
  vi.useFakeTimers();
  const f = await fixture({ workspaceId: "parent" });
  try {
    const child = f.log.openConversation(f.reference, {
      conversationId: 2,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      nextEventSeq: 1,
      resourceUse: { workspaceId: "child" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.facts.at(-1)).toMatchObject({
      kind: "session_activity",
      scope: f.identity,
      resources: [{ workspaceId: "parent" }, { workspaceId: "child" }],
    });
    await child.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.facts.at(-1)).toMatchObject({ resources: [{ workspaceId: "parent" }] });
  } finally {
    await f.log.close();
  }
});
it("coalesces fault checks and waits for a fresh reply and owner confirmation over HTTP", async () => {
  vi.useFakeTimers();
  const mailbox = new ToolReplyMailbox(),
    requests: PathProbe[] = [];
  const registered = vi.spyOn(mailbox, "waitProbe");
  const f = await fixture(undefined, (fact) => {
    if (fact.kind === "path_probe") {
      expect(registered).toHaveBeenCalledOnce();
      requests.push(fact);
    }
  });
  const owner = Promise.withResolvers<boolean>(),
    confirm = vi.fn(() => owner.promise);
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    report: vi.fn(),
    confirm,
    partitionFor: () => 0,
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
    expect(f.facts.map((f) => f.kind)).toEqual(["durable_commit", "path_probe"]);
    expect(mailbox.size).toBe(0);
  } finally {
    owner.resolve(false);
    mailbox.close();
    await f.log.close();
  }
});
it.each(["lost_reply", "changed_binding", "stop", "closing_writer"])(
  "does not turn %s into readiness or writer revocation",
  async (fault) => {
    vi.useFakeTimers();
    const mailbox = new ToolReplyMailbox(),
      sent: PathProbe[] = [];
    const f = await fixture(undefined, (fact) => {
      if (fact.kind === "path_probe") sent.push(fact);
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
      mailbox.close();
      await f.log.close();
    }
  },
);
it("publishes child probes with the physical writer identity and the child's exact binding", async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    mailbox = new ToolReplyMailbox();
  f.log.configureExecutionProbes({
    topic: toolReplyTopic(crypto.randomUUID()),
    replies: mailbox,
    report: vi.fn(),
    confirm: async () => true,
    partitionFor: () => 0,
  });
  const child = f.log.openConversation(f.reference, {
    conversationId: 2,
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    nextEventSeq: 1,
  });
  try {
    const binding = crypto.randomUUID();
    f.log.bindRuntime(f.reference, binding, 2);
    const check = f.log.confirmExecution(f.reference, binding, 2, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.facts.at(-1)).toMatchObject({
      kind: "path_probe",
      scope: f.identity,
      execution: {
        bindings: [{ bindingId: binding, scope: { sessionId: child.publication.scope.sessionId } }],
      },
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await check).toBe(false);
  } finally {
    await child.close();
    mailbox.close();
    await f.log.close();
  }
});
