import { afterEach, expect, it, vi } from "vitest";
import { MAX_EXECUTION_FACT_BYTES } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { AcceptedFact, AcceptedFactReceipt } from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { NativeSessionLogPublisher } from "../src/native-session-log-publisher.ts";
import { prepareExecutionFact } from "../src/prepare-execution-fact.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";
import { toolCommandForFact } from "../src/tool-invocation-fact.ts";
import { SessionPublicationIngress } from "../src/session-publication-ingress.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";

const logs: WorkerExecutionLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close()));
});

it("keeps large arguments at the existing checkpoint size and reconstructs the exact command", () => {
  const { fact, command } = toolInvocationFixture("x".repeat(360_000));
  const serialized = JSON.stringify(fact);
  expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_EXECUTION_FACT_BYTES);
  expect(serialized.match(/x{360000}/g)).toHaveLength(2); // native intent + existing display event
  const decoded = parseKafkaAcceptedFact(serialized);
  expect(toolCommandForFact(decoded)).toEqual({
    kind: "tool_command",
    factId: command.request.operationId,
    scope: { ...fact.scope, leaseId: fact.scope.writerId },
    request: command.request,
    toolCallId: command.toolCallId,
    occurredAt: fact.occurredAt,
    replyTopic: command.replyTopic,
  });
});

it.each(["executionReference", "toolCallId", "args", "toolName", "providerId", "intent", "lane"])(
  "rejects a mismatched %s before publication",
  (field) => {
    const { scope, executionReference, mutation } = toolInvocationFixture();
    const candidate = structuredClone(mutation);
    const command = candidate.toolCommand!;
    const request = command.request as any;
    if (field === "executionReference") Object.assign(command, { executionReference: "other" });
    if (field === "toolCallId") Object.assign(command, { toolCallId: "other" });
    if (field === "args") request.args = { ...request.args, content: "changed" };
    if (field === "toolName") request.toolName = "bash";
    if (field === "providerId") request.toolCallId = "other";
    if (field === "intent") Object.assign(candidate, { items: [] });
    if (field === "lane") Object.assign(candidate.scope, { piSessionLane: "child" });
    expect(() =>
      prepareExecutionFact(
        { ...scope, executionReference },
        {
          kind: "pi_session_append",
          mutation: candidate,
        },
      ),
    ).toThrow();
  },
);

it("rejects duplicate command arguments rather than giving them another authority", () => {
  const { fact } = toolInvocationFixture();
  Object.assign(fact.command.request, { args: { command: "unexpected" } });
  expect(() => parseKafkaAcceptedFact(JSON.stringify(fact))).toThrow("reuse its native intent");
});

it("checks the enclosing tenant, Session, Run, writer and Lane before dispatch", async () => {
  const { scope, fact } = toolInvocationFixture();
  const ingress = new SessionPublicationIngress();
  const owner = ingress.installPartition(0, {
    append: async (record) => ({ factId: record.factId, durable: true }),
    close: async () => {},
  });
  ingress.installRun(owner, { scope });
  await expect(ingress.append(owner, fact)).resolves.toMatchObject({ durable: true });
  for (const key of ["tenantId", "sessionId", "runId", "writerId", "piSessionId"] as const)
    await expect(
      ingress.append(owner, { ...fact, scope: { ...fact.scope, [key]: "other" } }),
    ).rejects.toBeInstanceOf(Error);
  await expect(
    ingress.append(owner, { ...fact, piSession: { ...fact.piSession, lane: "other" } }),
  ).rejects.toBeInstanceOf(Error);
});

async function publisherFixture() {
  const f = toolInvocationFixture();
  const ack = Promise.withResolvers<AcceptedFactReceipt>();
  const append = vi.fn((_fact: AcceptedFact) => ack.promise);
  const log = new WorkerExecutionLog({} as Kysely<Database>, {
    append,
    checkHealth: async () => {},
  });
  logs.push(log);
  const writer = await log.open({
    executionReference: f.executionReference,
    sessionId: f.scope.sessionId,
    turnId: f.scope.turnId,
    nextEventSeq: 1,
    piSession: { id: f.scope.piSessionId, lane: "main", writerId: f.scope.writerId },
    publication: { scope: f.scope },
  });
  const publisher = new NativeSessionLogPublisher({
    channels: log,
    toolReplyTopic: "reply-worker-boot",
  }).scoped(f.mutation.scope);
  return { ...f, writer, publisher, append, ack };
}

it("publishes intent and command once, advancing the display watermark only after the matching ACK", async () => {
  const f = await publisherFixture();
  const pending = f.publisher.publish(f.mutation.items as any, f.mutation.events, {
    toolCommand: f.command,
  });
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  const fact = f.append.mock.calls[0]![0];
  expect(fact.kind).toBe("tool_invocation");
  expect(f.writer.acknowledgedThroughSeq).toBe(0);
  f.ack.resolve({ factId: fact.factId, durable: true });
  await pending;
  expect(f.writer.acknowledgedThroughSeq).toBe(5);
  expect(f.append).toHaveBeenCalledOnce();
  await expect(f.writer.publishToolCommand(f.command)).rejects.toThrow("atomic native intent");
  expect(f.append).toHaveBeenCalledOnce();
});

it("does not enqueue an invocation cancelled before publication", async () => {
  const f = await publisherFixture();
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(
    f.publisher.publish(f.mutation.items as any, [], {
      toolCommand: f.command,
      signal: abort.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect(f.append).not.toHaveBeenCalled();
});

it.each(["lost", "mismatched"])("never retries the invocation after an %s ACK", async (mode) => {
  const f = await publisherFixture();
  const pending = f.publisher.publish(f.mutation.items as any, f.mutation.events, {
    toolCommand: f.command,
  });
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
  if (mode === "lost") f.ack.reject(new Error("ack lost"));
  else f.ack.resolve({ durable: true, factId: "wrong" });
  await rejection;
  await expect(
    f.publisher.publish(f.mutation.items as any, [], { toolCommand: f.command }),
  ).rejects.toThrow();
  expect(f.append).toHaveBeenCalledOnce();
  expect(f.writer.acknowledgedThroughSeq).toBe(0);
});
