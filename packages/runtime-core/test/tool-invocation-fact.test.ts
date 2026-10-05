import { afterEach, expect, it, vi } from "vitest";
import { MAX_EXECUTION_FACT_BYTES, PublicationNotSentError } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { AcceptedFact, AcceptedFactReceipt } from "../src/accepted-fact.ts";
import { WorkerExecutionLog } from "../src/worker-execution-log.ts";
import { DurableSessionPublisher } from "../src/durable-session-publisher.ts";
import { parseKafkaAcceptedFact } from "../src/kafka-accepted-fact.ts";
import { toolCommandsForFact } from "../src/tool-invocation-fact.ts";
import { SessionPublicationIngress } from "../src/session-publication-ingress.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
const logs: WorkerExecutionLog[] = [];
afterEach(async () => {
  await Promise.allSettled(logs.splice(0).map((log) => log.close()));
});

it("stores large validated arguments once and expands the exact owned Cube command", () => {
  const { fact, command } = toolInvocationFixture("x".repeat(360000));
  const encoded = JSON.stringify(fact);
  expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_EXECUTION_FACT_BYTES);
  expect(encoded.match(/x{360000}/g)).toHaveLength(1);
  expect(toolCommandsForFact(parseKafkaAcceptedFact(encoded))).toEqual([
    {
      kind: "tool_command",
      factId: command.request.operationId,
      scope: { ...fact.scope, leaseId: fact.scope.writerId },
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
  expect(() => parseKafkaAcceptedFact(JSON.stringify(fact))).toThrow("duplicates native intent");
});

it("checks the enclosing and independently admitted effect scopes without a per-record database query", async () => {
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
  const changed = structuredClone(fact);
  Object.assign(changed.tools[0]!.scope, { runId: "other" });
  await expect(ingress.append(owner, changed)).rejects.toBeInstanceOf(Error);
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
    piSession: { id: f.scope.piSessionId, conversationId: 1, writerId: f.scope.writerId },
    publication: { scope: f.scope },
  });
  const publisher = new DurableSessionPublisher({
    channels: log,
    replyTopic: "reply-worker-boot",
  }).scoped(f.executionReference);
  return { ...f, writer, publisher, append, ack };
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
  await expect(f.writer.publishToolCommand(f.command)).rejects.toThrow("atomic native intent");
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
