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
    kind: "pi_session_append",
    factId: `fact-${offset}`,
    scope: { ...scope, ...extra },
    piSession: { id: "physical", lane: "main", writerId: "writer" },
    items: [],
    events: [],
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
    observation: { type: "run.execution", execution: { status: "not_applicable" } },
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
  expect(await main.next()).toMatchObject({ observation: { type: "run.path", sentAt: now } });
  expect(await child.next()).toMatchObject({ observation: { type: "run.path", sentAt: now } });
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
    observation: { type: "run.activity", lastActivityAt: now - 10_000 },
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
        closesWriter: true,
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
