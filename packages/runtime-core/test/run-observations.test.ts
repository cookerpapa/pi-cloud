import { expect, it } from "vitest";
import type {
  ConversationDetailResource,
  PiCloudEvent,
  RunActivityDelivery,
} from "@pi-cloud/protocol";
import { SessionEventHub } from "../src/session-event-hub.ts";
import { RunObservations } from "../src/run-observations.ts";
import { RunObservationView } from "../src/run-observation-view.ts";
import type { KafkaAcceptedFactRecord } from "../src/kafka-accepted-fact-consumer.ts";
import { ExecutionStreamProjector } from "../src/execution-stream-projection.ts";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";

const scope = {
  tenantId: "tenant",
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  writerId: "writer",
  piSessionId: "physical",
  fencingToken: 1,
};
const record = (
  at: number,
  offset: bigint,
  extra: Partial<typeof scope> = {},
): KafkaAcceptedFactRecord => ({
  fact: {
    kind: "durable_commit",
    factId: `fact-${offset}`,
    scope: { ...scope, ...extra },
    commit: { seq: 1, nextId: 2, writes: [] },
    origins: [],
    tools: [],
    cancellations: [],
    display: [],
    occurredAt: new Date(at).toISOString(),
  },
  topic: "execution",
  partition: 0,
  offset,
});

it("records stage confirmations without replacing activity, preserves freshness and rejects old targets", async () => {
  let now = 100_000;
  const hub = new SessionEventHub(),
    observations = new RunObservations(hub, () => now),
    sub = hub.subscribe("tenant", "session");
  observations.record(record(now, 1n), true);
  await sub.next();
  observations.executionTargets(scope.writerId, [], now);
  expect(await sub.next()).toMatchObject({
    observation: { type: "run.execution", generation: 1, execution: { status: "not_applicable" } },
  });
  now += 1000;
  observations.execution(scope, {
    status: "confirmed",
    stage: "worker",
    bindingId: "b",
    targetId: "vm",
    sentAt: now,
    confirmedAt: now,
  });
  expect(await sub.next()).toMatchObject({ observation: { execution: { confirmedAt: now } } });
  observations.execution(scope, {
    status: "pending",
    stage: "cube",
    bindingId: "b",
    targetId: "vm",
    sentAt: now,
  });
  expect(await sub.next(1)).toBe("heartbeat");
  now += 15000;
  observations.execution(scope, {
    status: "pending",
    stage: "projector",
    bindingId: "b",
    sentAt: now,
  });
  expect(await sub.next()).toMatchObject({
    observation: { execution: { confirmedAt: 101000, targetId: "vm" } },
  });
  observations.execution(scope, {
    status: "pending",
    stage: "projector",
    bindingId: "b",
    targetId: "new-vm",
    sentAt: now,
  });
  const next = await sub.next();
  expect(next).toMatchObject({ observation: { execution: { targetId: "new-vm" } } });
  expect(next).not.toHaveProperty("observation.execution.confirmedAt");
  observations.reset();
  observations.execution(scope, {
    status: "confirmed",
    stage: "worker",
    bindingId: "b",
    sentAt: now,
    confirmedAt: now,
  });
  expect(await sub.next(1)).toBe("heartbeat");
  hub.onApplicationShutdown();
});

it("shares Session path evidence across Lanes while rejecting replay, stale and future probes", async () => {
  let now = 100_000;
  const hub = new SessionEventHub(),
    observations = new RunObservations(hub, () => now);
  const main = hub.subscribe("tenant", "session"),
    child = hub.subscribe("tenant", "child");
  const otherTenant = hub.subscribe("other", "session");
  observations.record(record(now, 1n), true);
  observations.record(
    record(now, 2n, { sessionId: "child", runId: "child-run", turnId: "child-turn" }),
    true,
  );
  await main.next();
  await child.next();
  now += 15_000;
  const probe = {
    ...record(now, 3n),
    fact: {
      kind: "path_probe" as const,
      factId: "probe",
      scope,
      occurredAt: new Date(now).toISOString(),
    },
  };
  observations.record(probe, true);
  expect(await main.next()).toMatchObject({
    observation: { type: "run.path", generation: 1, sentAt: now },
  });
  expect(await child.next()).toMatchObject({
    observation: { type: "run.path", generation: 1, sentAt: now },
  });
  observations.record(probe, true);
  observations.record(
    {
      ...probe,
      offset: 4n,
      fact: { ...probe.fact, occurredAt: new Date(now - 60_000).toISOString() },
    },
    true,
  );
  observations.record(
    {
      ...probe,
      offset: 5n,
      fact: { ...probe.fact, occurredAt: new Date(now + 60_000).toISOString() },
    },
    true,
  );
  expect(await main.next(1)).toBe("heartbeat");
  expect(await otherTenant.next(1)).toBe("heartbeat");
  observations.reset();
  observations.record({ ...probe, offset: 6n }, true);
  expect(await main.next(1)).toBe("heartbeat"); // probe cannot create an active scope
  hub.onApplicationShutdown();
});

it("authenticates observations against projected scopes and closes all Lanes on writer seal", async () => {
  const now = Date.now(),
    hub = new SessionEventHub(),
    observations = new RunObservations(hub);
  const sub = hub.subscribe("tenant", "session");
  observations.record(record(now, 1n), true);
  await sub.next();
  const value: RunActivityDelivery = {
    scope,
    partition: 0,
    observedAt: now,
    lastActivityAt: now - 10_000,
    phase: "waiting_model",
    revision: 1,
  };
  observations.activity({ ...value, scope: { ...scope, writerId: "old-writer" } });
  observations.activity({ ...value, scope: { ...scope, tenantId: "other" } });
  observations.activity({ ...value, partition: 1 });
  observations.activity({ ...value, lastActivityAt: now + 1 });
  expect(await sub.next(1)).toBe("heartbeat");
  observations.activity(value);
  expect(await sub.next()).toMatchObject({
    observation: { type: "run.activity", generation: 1, lastActivityAt: now - 10_000 },
  });
  observations.activity(value);
  expect(await sub.next(1)).toBe("heartbeat");
  observations.record(
    {
      ...record(now, 2n),
      fact: {
        kind: "execution_seal",
        scope: { ...scope, runId: "another-lane" },
        factId: "seal",
        agentId: "agent",
        baseSequence: 1,

        terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
        occurredAt: new Date(now).toISOString(),
      },
    },
    false,
  );
  observations.activity({ ...value, revision: 2 });
  expect(await sub.next(1)).toBe("heartbeat");
  hub.onApplicationShutdown();
});

it("never writes probes to PG or creates a native recovery floor", async () => {
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error("Probe touched PostgreSQL");
      },
    },
  );
  const projector = new ExecutionStreamProjector(database as Kysely<Database>);
  const probe = {
    ...record(Date.now(), 1n),
    fact: {
      kind: "path_probe" as const,
      factId: "probe",
      scope,
      occurredAt: new Date().toISOString(),
    },
  };
  expect(projector.observes(probe)).toBe(false);
  await expect(projector.project(probe)).resolves.toBeUndefined();
});

it("keeps latest bounded SSE observations and lets terminal events win", async () => {
  const hub = new SessionEventHub(),
    sub = hub.subscribe("tenant", "session"),
    now = Date.now();
  const value = {
    type: "run.activity" as const,
    generation: 1,
    sessionId: "session",
    turnId: "turn",
    runId: "run",
    revision: 1,
    phase: "waiting_model" as const,
    observedAt: now,
    lastActivityAt: now,
  };
  for (let revision = 1; revision <= 10_000; revision++)
    hub.publishObservation("tenant", { ...value, revision });
  expect(await sub.next()).toMatchObject({ observation: { revision: 10_000 } });
  const view = new RunObservationView({
    turns: [{ turnId: "turn", runId: "run", state: "running" }],
  } as ConversationDetailResource);
  expect(view.accept(value)).toBe(true);
  expect(view.accept(value)).toBe(false);
  expect(view.accept({ ...value, revision: 2, runId: "old" })).toBe(false);
  view.event({ type: "turn.cancelled", turnId: "turn" } as PiCloudEvent);
  expect(view.accept({ ...value, revision: 2 })).toBe(false);
  sub.close();
  const reopened = hub.subscribe("tenant", "session");
  expect(await reopened.next(1)).toBe("heartbeat");
  hub.onApplicationShutdown();
});

it("resyncs readers when same-generation observation counters expire", async () => {
  let now = Date.now();
  const hub = new SessionEventHub(),
    observations = new RunObservations(hub, () => now);
  const sub = hub.subscribe(scope.tenantId, scope.sessionId);
  observations.record(record(now, 1n), true);
  await sub.next();
  now += 300_001;
  observations.sweep();
  expect(await sub.next()).toEqual({ throughSequence: null });
  expect(observations.isActive(scope)).toBe(false);
  sub.close();
  const fresh = hub.subscribe(scope.tenantId, scope.sessionId);
  observations.record(record(now, 2n), true);
  await fresh.next();
  observations.executionTargets(scope.writerId, [], now);
  expect(await fresh.next()).toMatchObject({ observation: { generation: 1, revision: 1 } });
  hub.onApplicationShutdown();
});

it("coalesces across observation generations without retaining older types or lower revisions", async () => {
  const hub = new SessionEventHub(),
    sub = hub.subscribe("t", "s");
  const base = {
    sessionId: "s",
    turnId: "turn",
    runId: "run",
    generation: 1,
    observedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  hub.publishObservation("t", {
    ...base,
    type: "run.activity",
    revision: 100,
    phase: "waiting_model",
  });
  hub.publishObservation("t", {
    ...base,
    type: "run.execution",
    revision: 100,
    execution: { status: "not_applicable", stage: "projector", sentAt: Date.now() },
  });
  const next = { ...base, generation: 2, type: "run.path" as const, sentAt: Date.now() };
  hub.publishObservation("t", next);
  hub.publishObservation("t", {
    ...base,
    type: "run.activity",
    revision: 1000,
    phase: "waiting_model",
  });
  expect(await sub.next()).toMatchObject({ observation: next });
  expect(await sub.next(1)).toBe("heartbeat");
  hub.publishObservation("t", { ...next, sentAt: next.sentAt + 1 });
  hub.publishObservation("t", next);
  expect(await sub.next()).toMatchObject({ observation: { sentAt: next.sentAt + 1 } });
  hub.onApplicationShutdown();
});
