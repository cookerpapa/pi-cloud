import { admitTestExecution } from "./admit-test-execution.ts";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresNativeSessionHost, CloudAgentRuntime } from "@pi-cloud/pi-session-postgres";
import {
  EventStream,
  type AssistantMessageEvent,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { RunExecutor, TurnExecutionBackendError } from "../../runtime-core/src/run-executor.ts";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { DirectExecutionLog } from "../../runtime-core/src/direct-execution-log.ts";
import { ExecutionPublicationBoundary } from "../../runtime-core/src/execution-publication.ts";
import { NativeSessionLogPublisher } from "../../runtime-core/src/native-session-log-publisher.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import type { AcceptedFact, AcceptedFactWriter } from "../../runtime-core/src/accepted-fact.ts";
import { PostgresSubagentJobProvider } from "../../trusted-tool-runtime/src/postgres-subagent-job-provider.ts";
import { expect, it, vi } from "vitest";

it("runs claimed Parent/Child Lanes with PG projection paused, then cold-restores on a replacement Host", async () => {
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  let host = new PostgresNativeSessionHost({ database: db });
  const facts: AcceptedFact[] = [],
    channels = new Map<string, AcceptedFactWriter>();
  const service = new DirectExecutionLog(db, {
    append: async (fact) => {
      facts.push(fact);
      return { factId: fact.factId, durable: true };
    },
    checkHealth: async () => {},
  });
  const publisher = new NativeSessionLogPublisher({
    channels: { resolve: (lease) => channels.get(lease), checkHealth: async () => {} },
  });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: "native-host",
      ownerDisplayName: "Native host",
    });
    const store = new ControlPlaneStore({
      database: db,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    const project = await store.createProject({ name: "native-host", source: { kind: "empty" } });
    await db
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .execute();
    const conversation = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Native host",
      "elastic",
    );
    let childId: string | undefined,
      childExecutionId: string | undefined,
      phase = 1;
    let parentWriterId: string | undefined;
    const failures: unknown[] = [];
    const makeExecutor = async (owner: string) => {
      const sandboxId = crypto.randomUUID();
      await db
        .insertInto("sandboxes")
        .values({
          id: sandboxId,
          supervisor_id: owner,
          boot_id: crypto.randomUUID(),
          state: "ready",
          max_concurrent_sessions: 8,
        })
        .execute();
      const coordinator = new SessionLeaseCoordinator({ database: db, sandboxId });
      return new RunExecutor({
        database: db,
        workerId: sandboxId,
        executionAuthority: coordinator,
        backend: {
          admit: (tx, request, _mark, facts) => admitTestExecution(coordinator, tx, request, facts),
          async execute(request, _lifecycle, admission) {
            try {
              const grant = admission!;
              const scope = {
                tenantId: request.tenantId,
                sessionId: request.sessionId,
                piSessionId: request.piSessionId,
                piSessionLane: request.piSessionLane,
                turnId: request.turnId,
                runId: request.runId,
              };
              const opening = {
                executionReference: grant.executionReference,
                sessionId: request.sessionId,
                turnId: request.turnId,
                nextEventSeq: Number(request.nextEventSeq),
                piSession: {
                  id: request.piSessionId,
                  lane: request.piSessionLane,
                  writerId: grant.publication.scope.writerId,
                },
              };
              const publication = admission!.publication;
              const channel = await service.open({ ...opening, publication });
              channels.set(grant.executionReference, channel);
              const readCancellation = new AbortController();
              const session = await host.open({
                scope,
                writerId: grant.publication.scope.writerId,
                executionReference: grant.executionReference,
                readSignal: readCancellation.signal,
                publisher: publisher.scoped({
                  ...scope,
                  writerId: grant.publication.scope.writerId,
                  executionReference: grant.executionReference,
                }),
              });
              try {
                if (phase === 4) {
                  const runtime = new CloudAgentRuntime({
                    session: session.session,
                    lane: session.lane,
                    authority: session.authority,
                    idGenerator: () => session.session.idGenerator.next(),
                    model: getModel("openai", "gpt-4o-mini"),
                    systemPrompt: "test",
                    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
                    commitCheckpoint: async (operation) => {
                      await session.mutationPublisher.mutate(operation);
                    },
                    streamFn: (_model, context) => {
                      const text = JSON.stringify(context.messages);
                      expect(text.match(/visible-interrupted-prefix/g)).toHaveLength(1);
                      expect(text).toContain("turn_aborted");
                      const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
                        (e) => e.type === "done" || e.type === "error",
                        (e) => {
                          if (e.type === "done") return e.message;
                          if (e.type === "error") return e.error;
                          throw new Error("unexpected event");
                        },
                      );
                      const message: AssistantMessage = {
                        role: "assistant",
                        api: "openai-completions",
                        provider: "openai",
                        model: "gpt-4o-mini",
                        content: [{ type: "text", text: "Recovered" }],
                        stopReason: "stop",
                        timestamp: Date.now(),
                        usage: {
                          input: 0,
                          output: 0,
                          cacheRead: 0,
                          cacheWrite: 0,
                          totalTokens: 0,
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        },
                      };
                      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
                      return stream;
                    },
                  });
                  expect(await runtime.run(request.input.prompt)).toMatchObject({
                    kind: "completed",
                  });
                  return { stopReason: "stop" };
                }
                if (request.piSessionLane === "main" && phase === 2) {
                  expect(grant.publication.scope.writerId).not.toBe(parentWriterId);
                  const path = await session.session
                    .view("main")
                    .findEntriesOnBranch({ stopAtType: "compaction", order: "newestFirst" });
                  path.reverse();
                  expect(path[0]?.type).toBe("compaction");
                  expect(JSON.stringify(path)).toContain("parent-answer");
                  expect(JSON.stringify(path)).not.toContain("child-answer");
                }
                const op = session.session.idGenerator.next();
                await session.session.appendRecord({
                  id: op,
                  lane: session.lane,
                  type: "operation_started",
                  sourceLeafId: await session.session.view(session.lane).getLeafId(),
                  intent: { kind: "run", originalPrompt: [], initialMessages: [] },
                });
                await session.session.view(session.lane).appendMessage({
                  role: "user",
                  content: request.input.prompt,
                  timestamp: Date.now(),
                });
                if (phase === 3) {
                  const id = crypto.randomUUID();
                  await channel.ingest({
                    protocolVersion: 1,
                    messageId: id,
                    sentAt: new Date().toISOString(),
                    type: "event.publish",
                    payload: {
                      executionReference: grant.executionReference,
                      event: {
                        schemaVersion: 1,
                        eventId: id,
                        sessionId: request.sessionId,
                        turnId: request.turnId,
                        agentId: "root",
                        seq: Number(request.nextEventSeq),
                        occurredAt: new Date().toISOString(),
                        type: "assistant.text.delta",
                        payload: { text: "visible-interrupted-prefix" },
                      },
                    },
                  });
                  throw new TurnExecutionBackendError(
                    "worker_lost",
                    "Injected Worker loss during a response",
                    false,
                  );
                }
                if (request.piSessionLane === "main" && phase === 1) {
                  parentWriterId = grant.publication.scope.writerId;
                  const jobs = new PostgresSubagentJobProvider({ database: db, nativeLanes: host });
                  const child = await jobs.start({
                    tenantId: request.tenantId,
                    parentSessionId: request.sessionId,
                    parentRunId: request.runId,
                    parentExecutionReference: grant.executionReference,
                    parentToolCallId: "delegate",
                    workflowRunId: "workflow",
                    stepIndex: 0,
                    agentName: "cloud-child",
                    prompt: "child task",
                    contextMode: "branch",
                    sandboxMode: "none",
                  });
                  childId = child.childSessionId;
                  childExecutionId = child.executionId;
                  expect(
                    await db
                      .selectFrom("pi_session_lanes")
                      .select("lane")
                      .where("lane", "=", `subagent-${child.executionId}`)
                      .executeTakeFirst(),
                  ).toBeUndefined();
                  await new Promise((resolve) => setTimeout(resolve, 90));
                  expect(await executor.dispatchRun(child.childRunId)).toMatchObject({
                    status: "completed",
                  });
                  expect(await jobs.status(request.tenantId, child.executionId)).toMatchObject({
                    state: "running",
                  });
                  await session.session.appendEntry(
                    {
                      id: session.session.idGenerator.next(),
                      type: "compaction",
                      summary: "parent summary",
                      retainedTail: [],
                      tokensBefore: 100,
                    },
                    session.lane,
                  );
                } else if (request.piSessionLane !== "main") {
                  expect(grant.publication.scope.writerId).toBe(parentWriterId);
                  // Projection is deliberately stopped. Cancel only this task's
                  // cold read, then complete its native writes and the parent.
                  let readOutcome: unknown = "pending";
                  const history = session.session.getLog().then(
                    () => {
                      readOutcome = "resolved";
                    },
                    (error) => {
                      readOutcome = error;
                    },
                  );
                  await new Promise((resolve) => setTimeout(resolve, 50));
                  expect(readOutcome).toBe("pending");
                  const reason = new Error("Child history read cancelled");
                  readCancellation.abort(reason);
                  await vi.waitFor(() => expect(readOutcome).toBe(reason));
                  await history;
                }
                await session.session.view(session.lane).appendMessage({
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: request.piSessionLane === "main" ? "parent-answer" : "child-answer",
                    },
                  ],
                  api: "openai-completions",
                  provider: "test",
                  model: "test",
                  stopReason: "stop",
                  timestamp: Date.now(),
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                });
                await session.session.appendRecord({
                  id: session.session.idGenerator.next(),
                  lane: session.lane,
                  type: "operation_finished",
                  runId: op,
                  outcome: "completed",
                });
              } finally {
                await session.authority.close();
                await channel.close();
                channels.delete(grant.executionReference);
              }
              return { stopReason: "stop" };
            } catch (error) {
              failures.push(error instanceof Error ? error.stack : error);
              throw error;
            }
          },
        },
      });
    };
    let executor = await makeExecutor("worker-one");
    const first = await store.acceptTurn(conversation.sessionId, "first", {
      prompt: "parent task",
    });
    const outcome = await executor.dispatchRun(first.runId);
    expect(outcome, JSON.stringify({ outcome, failures })).toMatchObject({ status: "completed" });
    expect(
      await db
        .selectFrom("pi_session_log")
        .select("seq")
        .where("session_id", "=", conversation.sessionId)
        .execute(),
    ).toEqual([]);
    expect(new Set(facts.map((f) => f.scope.piSessionId))).toEqual(
      new Set([conversation.sessionId]),
    );
    expect(new Set(facts.map((f) => f.scope.writerId))).toEqual(new Set([parentWriterId]));
    const projector = new ExecutionStreamProjector(db);
    const boundary = new ExecutionPublicationBoundary(db);
    let offset = 0n;
    const projectReady = async () => {
      const pending = facts.splice(0);
      for (const fact of pending) {
        const record = { fact, topic: "native-host", partition: 0, offset: offset++ };
        expect(fact).not.toHaveProperty("signature");
        expect(
          await boundary.accept({
            ...record,
            fact: {
              ...fact,
              scope: { ...fact.scope, fencingToken: fact.scope.fencingToken + 1 },
            } as AcceptedFact,
          }),
        ).toBe(false);
        expect(await boundary.accept(record)).toBe(true);
        expect(await boundary.accept({ ...record, partition: 1 })).toBe(false);
        boundary.reset();
        expect(await boundary.accept(record)).toBe(true);
        await projector.project(record);
      }
      const terminals = await db
        .selectFrom("outbox")
        .select("payload")
        .where("aggregate_type", "=", "session_terminal_event")
        .orderBy("created_at")
        .execute();
      for (const row of terminals) {
        const record = {
          fact: row.payload as unknown as AcceptedFact,
          topic: "native-host",
          partition: 0,
          offset: offset++,
        };
        expect(await boundary.accept(record)).toBe(true);
        expect(
          await boundary.accept({
            ...record,
            fact: { ...record.fact, occurredAt: "2000-01-01T00:00:00.000Z" },
          }),
        ).toBe(false);
        await projector.project(record);
      }
      const late = pending.find((f) => f.kind === "pi_session_append")!;
      const lateRecord = { fact: late, topic: "native-host", partition: 0, offset: offset++ };
      // A genuine old identity is not sufficient after its seal, with or without signatures.
      boundary.reset();
      expect(await boundary.accept(lateRecord)).toBe(true);
      expect(await projector.accepts(lateRecord)).toBe(false);
      expect(await projector.project(lateRecord)).toBeUndefined();
    };
    await projectReady();
    expect(childId).toBeDefined();
    expect(
      await new PostgresSubagentJobProvider({ database: db, nativeLanes: host }).result(
        tenant.tenantId,
        childExecutionId!,
      ),
    ).toMatchObject({ state: "completed", output: "child-answer" });
    host.close();
    host = new PostgresNativeSessionHost({ database: db });
    phase = 2;
    executor = await makeExecutor("worker-two");
    const next = await store.acceptTurn(conversation.sessionId, "second", { prompt: "continue" });
    expect(await executor.dispatchRun(next.runId)).toMatchObject({ status: "completed" });
    await projectReady();
    phase = 3;
    const interrupted = await store.acceptTurn(conversation.sessionId, "interrupt", {
      prompt: "interrupt me",
    });
    expect(await executor.dispatchRun(interrupted.runId)).toMatchObject({ status: "failed" });
    await projectReady();
    expect(
      (
        await db
          .selectFrom("session_terminal_events")
          .select("interrupted_prefix")
          .where("turn_id", "=", interrupted.turnId)
          .executeTakeFirst()
      )?.interrupted_prefix,
    ).toBe("visible-interrupted-prefix");
    host.close();
    host = new PostgresNativeSessionHost({ database: db });
    phase = 4;
    executor = await makeExecutor("worker-three");
    const recover = await store.acceptTurn(conversation.sessionId, "recover", {
      prompt: "continue after interruption",
    });
    const recovered = await executor.dispatchRun(recover.runId);
    expect(recovered, JSON.stringify(failures)).toMatchObject({ status: "completed" });
    await projectReady();
    expect(
      (
        await db
          .selectFrom("session_terminal_events")
          .select("interrupted_prefix")
          .where("turn_id", "=", interrupted.turnId)
          .executeTakeFirst()
      )?.interrupted_prefix,
    ).toBeNull();
    expect(
      await db
        .selectFrom("pi_session_entries")
        .select("id")
        .where("turn_id", "=", interrupted.turnId)
        .where("custom_type", "=", "pi-cloud.interrupted_assistant_prefix")
        .execute(),
    ).toHaveLength(1);
  } finally {
    host.close();
    await publisher.close();
    await service.close();
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30_000);
