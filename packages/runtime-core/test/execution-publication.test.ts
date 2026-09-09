import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, type Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { ExecutionPublicationBoundary } from "../src/execution-publication.ts";
import type { AcceptedFact, ExecutionOpenedFact } from "../src/accepted-fact.ts";

let pg: PGlite;
let socket: PGLiteSocketServer;
let database: ReturnType<typeof createDatabase>;
let opening: ExecutionOpenedFact;

beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  // Isolate the opening transaction; the product schema/claim tests cover its
  // surrounding business tables. These are real PostgreSQL statements.
  await pg.exec(`create table run_attempts (
    id uuid primary key, tenant_id uuid, output_publication jsonb,
    output_open_offset bigint, output_first_topic text, output_first_partition int,
    output_first_offset bigint, output_sealed_at timestamptz,
    native_writer_id uuid, native_writer_sealed_at timestamptz
  ); create table accepted_fact_projection_offsets (
    topic text, partition int, next_offset bigint, primary key(topic,partition)
  );`);
});

beforeEach(async () => {
  const attemptId = crypto.randomUUID();
  const scope = {
    tenantId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId,
    fencingToken: 1,
    piSessionId: crypto.randomUUID(),
    writerId: attemptId,
  };
  const publication = {
    id: crypto.randomUUID(),
    scope: { ...scope, leaseId: crypto.randomUUID(), piSessionLane: "main" },
  };
  opening = {
    kind: "execution_opened",
    factId: publication.id,
    scope,
    publication,
    occurredAt: new Date().toISOString(),
  };
  await pg.exec("truncate run_attempts, accepted_fact_projection_offsets");
  await pg.query(
    "insert into run_attempts(id,tenant_id,output_publication,native_writer_id) values($1,$2,$3,$1)",
    [attemptId, scope.tenantId, JSON.stringify(publication)],
  );
});

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pg?.close();
});

function record(fact: AcceptedFact = opening, offset = 0n) {
  return { fact, topic: "publication-test", partition: 0, offset };
}
function delta(): AcceptedFact {
  return {
    kind: "agent_event",
    factId: crypto.randomUUID(),
    scope: opening.scope,
    occurredAt: opening.occurredAt,
    event: {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: opening.scope.sessionId,
      turnId: opening.scope.turnId,
      agentId: "root",
      seq: 1,
      occurredAt: opening.occurredAt,
      type: "assistant.text.delta",
      payload: { text: "accepted" },
    },
  };
}
function failTransactionOnce(phase: "before_commit" | "after_commit") {
  let inject = true;
  return new Proxy(database, {
    get(target, property) {
      if (property === "transaction")
        return () => ({
          execute: async (callback: (tx: Transaction<Database>) => Promise<unknown>) => {
            const result = await target.transaction().execute(async (tx) => {
              const value = await callback(tx);
              if (inject && phase === "before_commit") {
                inject = false;
                throw new Error("injected rollback");
              }
              return value;
            });
            if (inject && phase === "after_commit") {
              inject = false;
              throw new Error("injected lost commit reply");
            }
            return result;
          },
        });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("replays an opening after PostgreSQL committed but its acknowledgement was lost", async () => {
  const boundary = new ExecutionPublicationBoundary(failTransactionOnce("after_commit"));
  await expect(boundary.accept(record())).rejects.toThrow("lost commit reply");
  expect(
    (
      await database
        .selectFrom("run_attempts")
        .select("output_open_offset")
        .executeTakeFirstOrThrow()
    ).output_open_offset,
  ).toBe("0");
  expect(await boundary.accept(record())).toBe(true);
  expect(await boundary.accept(record(delta(), 1n))).toBe(true);
});

it("retries a rolled-back opening without caching a negative decision", async () => {
  const boundary = new ExecutionPublicationBoundary(failTransactionOnce("before_commit"));
  await expect(boundary.accept(record())).rejects.toThrow("rollback");
  expect(
    (
      await database
        .selectFrom("run_attempts")
        .select("output_open_offset")
        .executeTakeFirstOrThrow()
    ).output_open_offset,
  ).toBeNull();
  expect(await boundary.accept(record())).toBe(true);
  expect(await boundary.accept(record(delta(), 1n))).toBe(true);
});

it("adopts the first durable opening when two Projectors race", async () => {
  const a = new ExecutionPublicationBoundary(database),
    b = new ExecutionPublicationBoundary(database);
  expect(await Promise.all([a.accept(record()), b.accept(record())])).toEqual([true, true]);
  expect(await b.accept(record(opening, 2n))).toBe(true);
  expect(
    (
      await database
        .selectFrom("run_attempts")
        .select("output_open_offset")
        .executeTakeFirstOrThrow()
    ).output_open_offset,
  ).toBe("0");
});

it("requires the opening and exact scope but does not query PostgreSQL for each delta", async () => {
  const boundary = new ExecutionPublicationBoundary(database);
  expect(await boundary.accept(record(delta(), 1n))).toBe(false);
  expect(await boundary.accept(record())).toBe(true);
  expect(await boundary.accept({ ...record(), topic: "other" })).toBe(false);
  expect(await boundary.accept({ ...record(), partition: 1 })).toBe(false);
  expect(
    await boundary.accept(record({ ...opening, scope: { ...opening.scope, fencingToken: 2 } })),
  ).toBe(false);
  const reads = vi.spyOn(database, "selectFrom");
  for (let i = 1; i <= 100; i++)
    expect(await boundary.accept(record(delta(), BigInt(i)))).toBe(true);
  expect(reads).not.toHaveBeenCalled();
  reads.mockRestore();
  boundary.reset();
  expect(await boundary.accept(record(delta(), 101n))).toBe(true);
});

it("does not create an opening after the execution or its shared writer is sealed", async () => {
  const boundary = new ExecutionPublicationBoundary(database);
  await database.updateTable("run_attempts").set({ native_writer_sealed_at: new Date() }).execute();
  expect(await boundary.accept(record())).toBe(false);
  expect(await boundary.accept(record(delta(), 1n))).toBe(false);
  expect(
    (
      await database
        .selectFrom("run_attempts")
        .select("output_open_offset")
        .executeTakeFirstOrThrow()
    ).output_open_offset,
  ).toBeNull();
});
