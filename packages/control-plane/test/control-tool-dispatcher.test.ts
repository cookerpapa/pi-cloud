import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase } from "@pi-cloud/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { ControlToolDispatcher, type ControlToolOutcome } from "../src/control-tool-dispatcher.ts";
import type { DurableControlToolDispatch } from "@pi-cloud/runtime-core/accepted-fact";

const tenant = "20000000-0000-4000-8000-000000000001";
const run = "20000000-0000-4000-8000-000000000002";
const writer = "20000000-0000-4000-8000-000000000003";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
}, 60_000);

async function fixture(replayable = true) {
  const pg = await PGlite.create();
  cleanups.push(() => pg.close());
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  cleanups.push(() => socket.stop());
  const database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  cleanups.push(() => database.destroy());
  // A narrow SQL contract fixture: deliberately advance the mutable Task index
  // beyond its immutable Tool-intent commit. No mocked query builder is used.
  await pg.exec(`
    create table pi_sessions(tenant_id uuid,id text,session_hash bigint);
    create table pi_durable_records(tenant_id uuid,session_id text,id bigint,kind text,seq bigint,fields jsonb,retired_seq bigint);
    create table pi_durable_commits(tenant_id uuid,session_id text,seq bigint,cloud_metadata text);
    create table pi_durable_log(tenant_id uuid,session_id text,seq bigint,record_id bigint,record_kind text,body text);
    create table active_execution_scopes(tenant_id uuid,pi_session_id text,run_id uuid,writer_id uuid,fencing_token bigint,valid_until timestamptz,accepting_effects boolean);
  `);
  await sql`insert into pi_sessions values(${tenant}::uuid,'physical',1)`.execute(database);
  await sql`insert into active_execution_scopes values(${tenant}::uuid,'physical',${run}::uuid,${writer}::uuid,2,clock_timestamp()+interval '1 hour',true)`.execute(
    database,
  );
  const dispatch: DurableControlToolDispatch = {
    target: "control",
    operationId: "operation",
    taskId: 4,
    conversationId: 1,
    toolName: "subagent_control",
    contextAnchor: null,
    replyTopic: "worker-boot",
    scope: {
      tenantId: tenant,
      piSessionId: "physical",
      sessionId: "view",
      turnId: "turn",
      runId: run,
      writerId: writer,
      fencingToken: 2,
    },
  };
  const task = {
    id: 4,
    conversationId: 1,
    kind: "pi.tool",
    abortRequested: false,
    input: { callId: "provider-call" },
    state: {
      status: "running",
      checkpoint: { phase: "execute", arguments: { action: "status", target: "child" } },
    },
  };
  await sql`insert into pi_durable_records values(${tenant}::uuid,'physical',4,'task',19,
    ${JSON.stringify({ nativeKind: '"pi.tool"', status: "running", abortRequested: "false", conversation: "1" })}::jsonb,null)`.execute(
    database,
  );
  await sql`insert into pi_durable_commits values(${tenant}::uuid,'physical',8,${JSON.stringify({ controlTools: [dispatch] })})`.execute(
    database,
  );
  await sql`insert into pi_durable_log values(${tenant}::uuid,'physical',8,4,'task',${JSON.stringify({ type: "task", value: task })})`.execute(
    database,
  );
  const publish = vi.fn(async () => {});
  const execute = vi.fn(async (): Promise<ControlToolOutcome> => ({
    result: { content: [{ type: "text", text: "ready" }] },
  }));
  const dispatcher = new ControlToolDispatcher({
    database,
    partitions: 3,
    ownsPartition: (p) => p === 1,
    execute,
    publish,
    replayable: () => replayable,
  });
  cleanups.push(() => dispatcher.close());
  return { database, dispatch, dispatcher, execute, publish, task };
}

describe("native control Tool reconciliation", () => {
  it("keeps the same reference when recovered waits replay their original native intent", async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({ waiting: true });
    await f.dispatcher.recover([1], () => true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    const record = {
      topic: "native-controls",
      partition: 1,
      offset: 9n,
      fact: {
        kind: "durable_commit" as const,
        factId: "intent",
        scope: f.dispatch.scope,
        occurredAt: new Date().toISOString(),
        commit: { seq: 8, nextId: 5, writes: [{ type: "task" as const, value: f.task }] },
        origins: [],
        display: [],
        cancellations: [],
        tools: [f.dispatch],
      },
    };
    await expect(f.dispatcher.consume(record)).resolves.toBeUndefined();
    await f.dispatcher.recover([1], () => true);
    await expect(f.dispatcher.consume(record)).resolves.toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    const changed = structuredClone(record);
    changed.fact.tools = [{ ...f.dispatch, replyTopic: "changed-worker-boot" }];
    await expect(f.dispatcher.consume(changed)).rejects.toThrow(
      "Control dispatch identity changed",
    );
  }, 20_000);

  it("recovers the original intent after later Task updates and sends the shared mailbox payload", async () => {
    const f = await fixture();
    await f.dispatcher.recover([1], () => true);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeSequence: 8,
        arguments: { action: "status", target: "child" },
        nativeCallId: "provider-call",
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(f.publish).toHaveBeenCalledWith("worker-boot", {
      kind: "tool_result",
      operationId: "operation",
      sequence: 1,
      result: {
        toolName: "subagent_control",
        toolCallId: "provider-call",
        isError: false,
        result: { content: [{ type: "text", text: "ready" }] },
      },
    });
  }, 20_000);

  it("does not resurrect aborted Tasks or retired workflow hostcalls", async () => {
    const f = await fixture();
    await sql`update pi_durable_records set fields=jsonb_set(fields,'{abortRequested}','"true"'::jsonb)`.execute(
      f.database,
    );
    await f.dispatcher.recover([1], () => true);
    expect(f.execute).not.toHaveBeenCalled();
    const hostcall = { ...f.dispatch, sourceDocumentId: 7, replyMode: "hostcall" };
    await sql`update pi_durable_records set fields=jsonb_set(fields,'{abortRequested}','"false"'::jsonb)`.execute(
      f.database,
    );
    await sql`insert into pi_durable_records values(${tenant}::uuid,'physical',7,'document',8,'{}',20)`.execute(
      f.database,
    );
    await sql`update pi_durable_commits set cloud_metadata=${JSON.stringify({ controlTools: [hostcall] })}`.execute(
      f.database,
    );
    await f.dispatcher.recover([1], () => true);
    expect(f.execute).not.toHaveBeenCalled();
  }, 20_000);

  it("abandons a reply from the previous partition generation", async () => {
    const f = await fixture();
    let finish!: (outcome: ControlToolOutcome) => void;
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.dispatcher.recover([1], () => true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    f.dispatcher.reset();
    finish({ result: { content: [{ type: "text", text: "stale" }] } });
    await f.dispatcher.recover([1], () => true);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("stale");
    expect(f.execute).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("retries a failed mailbox publish without repeating the completed control effect", async () => {
    const f = await fixture();
    f.publish.mockRejectedValueOnce(new Error("Kafka unavailable"));
    await f.dispatcher.recover([1], () => true);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
    f.dispatcher.wake(tenant, "physical");
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    expect(f.execute).toHaveBeenCalledTimes(1);
  }, 20_000);
});

function intent(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    topic: "native-controls",
    partition: 1,
    offset: 9n,
    fact: {
      kind: "durable_commit" as const,
      factId: "intent",
      scope: f.dispatch.scope,
      occurredAt: new Date().toISOString(),
      commit: { seq: 8, nextId: 5, writes: [{ type: "task" as const, value: f.task }] },
      origins: [],
      display: [],
      cancellations: [],
      tools: [f.dispatch],
    },
  };
}

it("commits dispatch before a non-replayable effect and never repeats it after reply loss", async () => {
  const f = await fixture(false);
  const committed = Promise.withResolvers<boolean>();
  f.publish.mockRejectedValueOnce(new Error("lost Kafka reply"));
  const delivery = f.dispatcher.consume(
    intent(f),
    () => true,
    () => committed.promise,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.execute).not.toHaveBeenCalled();
  committed.resolve(true);
  await delivery;
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  f.dispatcher.wake(tenant, "physical");
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
  await f.dispatcher.consume(
    intent(f),
    () => true,
    async () => false,
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
}, 20_000);

it("recovers an uncertain effect as UNKNOWN and cannot start it on a later rewind", async () => {
  const f = await fixture(false);
  await f.dispatcher.recover([1], () => true);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(JSON.stringify(f.publish.mock.calls)).toContain("tool_result_unknown");
  await f.dispatcher.consume(
    intent(f),
    () => true,
    async () => true,
  );
  f.dispatcher.wake(tenant, "physical");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledTimes(1);
}, 20_000);

it("aborts the external request on owner loss and discards its late success", async () => {
  const f = await fixture(false);
  const completion = Promise.withResolvers<ControlToolOutcome>();
  f.execute.mockImplementationOnce(() => completion.promise);
  await f.dispatcher.consume(
    intent(f),
    () => true,
    async () => true,
  );
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
  const signal = (f.execute.mock.calls[0] as unknown as [unknown, unknown, AbortSignal])[2];
  f.dispatcher.reset();
  expect(signal.aborted).toBe(true);
  completion.resolve({ result: { content: [{ type: "text", text: "late picture" }] } });
  await f.dispatcher.recover([1], () => true);
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(1));
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain("late picture");
}, 20_000);
