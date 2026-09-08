import { afterEach, expect, it, vi } from "vitest";
import { createExecutionLease, type EventPublishMessage } from "@pi-cloud/protocol";
import { FactChannelService } from "../src/accepted-fact-channel.ts";
import { AcceptedFactCapacityError } from "../src/accepted-fact.ts";

afterEach(() => vi.useRealTimers());
it("does not retain an overflowed Fact in an outer retry queue or report a durable ACK", async () => {
  const f = fixture();
  f.bus.append.mockRejectedValue(new AcceptedFactCapacityError());
  const channel = await f.open();
  await expect(channel.ingest(f.publication)).rejects.toMatchObject({
    code: "event_capacity_exhausted",
  });
  expect(f.bus.append).toHaveBeenCalledOnce();
  expect(channel.acknowledgedThroughSeq).toBe(0);
  await expect(channel.close()).rejects.toMatchObject({ code: "event_capacity_exhausted" });
  await f.service.close();
});
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  let deliver!: () => void;
  const delivery = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const scope = {
    connectionId: id(1),
    instanceId: id(2),
    executionLease: createExecutionLease(id(3), id(4), 1),
    leaseId: id(3),
    attemptId: id(4),
    fencingToken: 1,
    tenantId: id(5),
    sessionId: id(6),
    piSessionId: id(6),
    piSessionLane: "main",
    runId: id(7),
    turnId: id(8),
    leaseDurationMs: 400,
  };
  const authority = {
    open: vi.fn(async () => scope),
    accept: vi.fn((_scope, candidate) => ({
      kind: "agent_event",
      factId: candidate.publication.payload.event.eventId,
    })),
    close: vi.fn(async () => {}),
    renewMany: vi.fn(async () => new Map([[scope.connectionId, 400]])),
  };
  const bus = {
    append: vi.fn(async (fact) => {
      await delivery;
      return { factId: fact.factId, durable: true as const };
    }),
    checkHealth: async () => {},
  };
  const progress = { recordMany: vi.fn(async () => new Set([scope.connectionId])) };
  const service = new FactChannelService({
    authority: authority as unknown as ConstructorParameters<
      typeof FactChannelService
    >[0]["authority"],
    bus,
    progress,
    instanceId: scope.instanceId,
    leaseDurationMs: 400,
  });
  const publication: EventPublishMessage = {
    protocolVersion: 1,
    type: "event.publish",
    messageId: id(9),
    sentAt: new Date().toISOString(),
    payload: {
      executionLease: scope.executionLease,
      event: {
        schemaVersion: 1,
        eventId: id(10),
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        agentId: "root",
        seq: 1,
        occurredAt: new Date().toISOString(),
        type: "assistant.text.delta",
        payload: { text: "durable" },
      },
    },
  };
  return {
    authority,
    bus,
    progress,
    service,
    deliver,
    publication,
    open: () =>
      service.open(
        {
          protocolVersion: 1,
          messageId: id(11),
          sentAt: new Date().toISOString(),
          type: "fact.channel.open",
          payload: {
            executionLease: scope.executionLease,
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            piSession: { id: scope.piSessionId, lane: "main" },
            nextEventSeq: 1,
          },
        },
        scope.connectionId,
        () => {},
      ),
  };
}

it("renews and drains an in-flight publication before closing and recording final progress", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const channel = await f.open();
  const publishing = channel.ingest(f.publication);
  await vi.advanceTimersByTimeAsync(0);
  const closing = channel.close();
  expect(channel.close()).toBe(closing);
  await expect(channel.ingest(f.publication)).rejects.toThrow("closing");
  await vi.advanceTimersByTimeAsync(300);
  expect(f.authority.renewMany.mock.calls.length).toBeGreaterThan(0);
  expect(f.authority.close).not.toHaveBeenCalled();
  expect(f.service.statistics().activeChannels).toBe(1);
  f.deliver();
  await publishing;
  await closing;
  expect(f.progress.recordMany).toHaveBeenLastCalledWith([
    expect.objectContaining({ acknowledgedThroughSeq: 1 }),
  ]);
  expect(f.authority.close).toHaveBeenCalledOnce();
  expect(f.service.statistics().activeChannels).toBe(0);
  await f.service.close();
});

it("does not report a successful close after publication loses authority", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.bus.append.mockRejectedValue(new Error("delivery unknown"));
  f.authority.renewMany.mockResolvedValue(new Map());
  const channel = await f.open();
  const publishing = channel.ingest(f.publication).catch((error: unknown) => error);
  const closing = channel.close().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(await publishing).toBeInstanceOf(Error);
  expect(await closing).toBeInstanceOf(Error);
  expect(f.authority.close).not.toHaveBeenCalled();
  f.deliver();
  await f.service.close();
});
