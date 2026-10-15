import { afterEach, expect, it, vi } from "vitest";
import { MAX_EXECUTION_FACT_BYTES, PublicationNotSentError } from "@pi-cloud/protocol";
import type { AcceptedFact, AcceptedFactReceipt } from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { DurableSessionPublisher } from "../src/durable-session-publisher.ts";
import { parseKafkaAcceptedFact, encodeSessionLogFact } from "../src/kafka-accepted-fact.ts";
import { toolCommandsForFact, controlToolsForFact } from "../src/tool-invocation-fact.ts";
import { assertSessionPublication } from "../src/direct-session-kafka.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
const logs: WorkerExecutionLog[] = [];
afterEach(async () => {
  await Promise.allSettled(logs.splice(0).map((log) => log.close()));
});

it("stores large validated arguments once and expands the exact owned Cube command", () => {
  const { fact, command } = toolInvocationFixture("x".repeat(360000));
  const encoded = encodeSessionLogFact(fact);
  expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_EXECUTION_FACT_BYTES);
  expect(encoded.match(/x{360000}/g)).toHaveLength(1);
  expect(toolCommandsForFact(parseKafkaAcceptedFact(encoded))).toEqual([
    {
      kind: "tool_command",
      scope: fact.scope,
      request: command.request,
      toolCallId: command.toolCallId,
      occurredAt: command.occurredAt,
      replyTopic: command.replyTopic,
    },
  ]);
});

it("rejects duplicate argument authority in a dispatch", () => {
  const { fact } = toolInvocationFixture();
  Object.assign(fact.tools[0]!.request, { args: {} });
  expect(() => parseKafkaAcceptedFact(encodeSessionLogFact(fact))).toThrow(
    "duplicates native intent",
  );
});

it("keeps child scopes under the same root writer without querying PG", () => {
  const { scope, fact } = toolInvocationFixture();
  expect(() => assertSessionPublication({ scope }, fact)).not.toThrow();
  for (const key of ["tenantId", "runId", "writerId", "piSessionId"] as const)
    expect(() =>
      assertSessionPublication({ scope }, { ...fact, scope: { ...fact.scope, [key]: "other" } }),
    ).toThrow();
  const changed = structuredClone(fact);
  Object.assign(changed.tools[0]!.scope, { runId: "other" });
  expect(() => assertSessionPublication({ scope }, changed)).toThrow();
});

async function publisherFixture() {
  const f = toolInvocationFixture();
  const ack = Promise.withResolvers<AcceptedFactReceipt>();
  const append = vi.fn((_fact: AcceptedFact) => ack.promise);
  const log = new WorkerExecutionLog({
    append,
    checkHealth: async () => {},
  });
  logs.push(log);
  const writer = await log.open({
    executionReference: f.executionReference,
    sessionId: f.scope.sessionId,
    turnId: f.scope.turnId,
    nextEventSeq: 1,
    piSession: { id: f.scope.piSessionId, conversationId: 1, writerId: f.scope.writerId },
    publication: { scope: f.scope },
  });
  const publisher = new DurableSessionPublisher({
    channels: log,
    replyTopic: "reply-worker-boot",
  }).scoped(f.executionReference);
  return { ...f, log, writer, publisher, append, ack };
}

it.each(["executionReference", "args", "providerId", "intent"] as const)(
  "rejects a mismatched %s before enqueueing",
  async (field) => {
    const f = await publisherFixture(),
      publication = structuredClone(f.publication);
    const command = publication.tools[0]!.command;
    if (field === "executionReference") Object.assign(command, { executionReference: "other" });
    if (field === "args") Object.assign(command.request, { args: { content: "changed" } });
    if (field === "providerId") Object.assign(command.request, { toolCallId: "other" });
    if (field === "intent") Object.assign(publication.commit, { writes: [] });
    await expect(f.publisher.publish(publication)).rejects.toBeInstanceOf(PublicationNotSentError);
    expect(f.append).not.toHaveBeenCalled();
  },
);

it("co-publishes native intent and command exactly once and rejects a separate fixed-Tool command", async () => {
  const f = await publisherFixture();
  const published = f.publisher.publish(f.publication);
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  const fact = f.append.mock.calls[0]![0];
  expect(fact.kind).toBe("durable_commit");
  f.ack.resolve({ factId: fact.factId, durable: true });
  await published;
  expect(f.append).toHaveBeenCalledOnce();
  expect("publishToolCommand" in f.writer).toBe(false);
});

it("addresses native child Tools, text and cancellation through the one root writer", async () => {
  const f = await publisherFixture();
  const child = f.log.openConversation(f.executionReference, {
    conversationId: 2,
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    nextEventSeq: 7,
  });
  const publication = structuredClone(f.publication);
  Object.assign(publication.commit.writes[0]!.value as object, { conversationId: 2 });
  Object.assign(publication.origins[0]!, {
    sessionId: child.publication.scope.sessionId,
    turnId: child.publication.scope.turnId,
  });
  const display = [
    { executionReference: f.executionReference, conversationId: 2, events: [], coveredThrough: 12 },
  ];
  const cancellations = [
    {
      executionReference: f.executionReference,
      conversationId: 2,
      activationId: f.command.request.activationId,
      operationId: f.command.request.operationId,
      occurredAt: f.command.occurredAt,
    },
  ];
  const writing = f.publisher.publish({ ...publication, display, cancellations });
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  const fact = f.append.mock.calls[0]![0];
  expect(fact.kind).toBe("durable_commit");
  if (fact.kind !== "durable_commit") throw new Error("Expected native batch");
  for (const scope of [fact.tools[0]!.scope, fact.cancellations[0]!.scope, fact.display[0]!.scope])
    expect(scope).toMatchObject({
      runId: f.scope.runId,
      writerId: f.scope.writerId,
      sessionId: child.publication.scope.sessionId,
      turnId: child.publication.scope.turnId,
    });
  f.ack.resolve({ factId: fact.factId, durable: true });
  await writing;
  expect(child.acknowledgedThroughSeq).toBe(12);
  expect(f.writer.acknowledgedThroughSeq).toBe(0);
  await child.close();
  expect(f.log.resolve(f.executionReference)).toBe(f.writer);
  expect(f.log.resolve(f.executionReference, 2)).toBeUndefined();
});

it("routes control tools from the same validated native commit without copying their arguments", async () => {
  const f = await publisherFixture();
  const args = { action: "run", task: "q".repeat(80000) };
  const commit = structuredClone(f.publication.commit);
  const task = commit.writes[0]!.value as {
    state: { checkpoint: { arguments: unknown } };
  };
  task.state.checkpoint.arguments = args;
  const publication = {
    ...f.publication,
    commit,
    tools: [
      {
        taskId: 4,
        command: {
          target: "control" as const,
          executionReference: f.executionReference,
          operationId: crypto.randomUUID(),
          toolCallId: "task:4",
          nativeCallId: "provider-1",
          conversationId: 1,
          toolName: "subagent" as const,
          arguments: args,
          contextAnchor: null,
          occurredAt: new Date().toISOString(),
        },
      },
    ],
  };
  const published = f.publisher.publish(publication);
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  const fact = f.append.mock.calls[0]![0];
  const encoded = encodeSessionLogFact(fact);
  expect(encoded.match(/q{80000}/g)).toHaveLength(1);
  const parsed = parseKafkaAcceptedFact(encoded);
  expect(toolCommandsForFact(parsed)).toEqual([]);
  expect(controlToolsForFact(parsed)).toMatchObject([
    {
      operationId: publication.tools[0]!.command.operationId,
      arguments: args,
      conversationId: 1,
      toolName: "subagent",
      nativeCallId: "provider-1",
      nativeSequence: commit.seq,
    },
  ]);
  f.ack.resolve({ factId: fact.factId, durable: true });
  await published;
  expect(() => assertSessionPublication({ scope: f.scope }, parsed)).not.toThrow();
  if (parsed.kind !== "durable_commit") throw new Error("Expected native batch");
  Object.assign(parsed.tools[0]!.scope, { runId: "different" });
  expect(() => assertSessionPublication({ scope: f.scope }, parsed)).toThrow();
  Object.assign(parsed.tools[0]!, { conversationId: 999 });
  Object.assign(parsed.tools[0]!.scope, { runId: f.scope.runId });
  expect(() => parseKafkaAcceptedFact(encodeSessionLogFact(parsed))).toThrow(
    "conversation changed",
  );
});

it.each(["lost", "mismatched"] as const)("does not retry an %s ACK", async (mode) => {
  const f = await publisherFixture();
  const published = f.publisher.publish(f.publication);
  void published.catch(() => {});
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  if (mode === "lost") f.ack.reject(new Error("lost ACK"));
  else f.ack.resolve({ factId: "wrong", durable: true });
  await expect(published).rejects.toBeInstanceOf(Error);
  expect(f.append).toHaveBeenCalledOnce();
  await expect(f.publisher.publish(f.publication)).rejects.toBeInstanceOf(Error);
  expect(f.append).toHaveBeenCalledOnce();
});
