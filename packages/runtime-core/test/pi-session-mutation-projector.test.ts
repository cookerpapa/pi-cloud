import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { expect, it } from "vitest";
import { PostgresPiSessionMutationProjector } from "../src/postgres-pi-session-mutation-projector.ts";
import type { AcceptedPiSessionMutationFact } from "../src/accepted-fact.ts";
import { up, down } from "../../database/src/migrations/126_compact_pi_mutation_results.ts";
import type { Kysely } from "kysely";

it("rolls back Session data with a failed receipt commit and replays one successful effect", async () => {
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  try {
    await runMigrations(db, "up");
    const tenantId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await db.insertInto("tenants").values({ id: tenantId, slug: "atomic-receipt-test" }).execute();
    const storage = await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
    const fact: AcceptedPiSessionMutationFact = {
      kind: "pi_session_mutation",
      factId: crypto.randomUUID(),
      scope: {
        tenantId,
        sessionId,
        runId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        fencingToken: 1,
      },
      piSession: { id: sessionId, lane: "main" },
      events: [],
      occurredAt: new Date().toISOString(),
      operation: { kind: "set_name", name: "atomic name" },
    };
    let failReceipt = true;
    const projector = new PostgresPiSessionMutationProjector(
      db.withPlugin({
        transformQuery({ node }) {
          if (
            failReceipt &&
            node.kind === "InsertQueryNode" &&
            JSON.stringify(node.into).includes('"pi_session_mutation_results"')
          )
            throw new Error("receipt unavailable");
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    await expect(projector.project(fact)).rejects.toThrow("receipt unavailable");
    expect(await storage.getName()).toBeUndefined();
    expect(await storage.getLog()).toHaveLength(0);
    failReceipt = false;
    await projector.project(fact);
    await projector.project(fact);
    expect(await storage.getLog()).toHaveLength(1);
    expect(await storage.getName()).toBe("atomic name");
    expect(
      await db
        .selectFrom("pi_session_mutation_results")
        .select("state")
        .where("mutation_id", "=", fact.factId)
        .executeTakeFirst(),
    ).toEqual({ state: "completed" });
    const entryId = crypto.randomUUID();
    const appendFact: AcceptedPiSessionMutationFact = {
      ...fact,
      factId: crypto.randomUUID(),
      operation: {
        kind: "append_items",
        items: [
          {
            kind: "append_record",
            record: {
              id: entryId,
              lane: "main",
              type: "operation_started",
              sourceLeafId: null,
              intent: {
                kind: "run",
                originalPrompt: [
                  { role: "user", content: "payload-".repeat(20000), timestamp: Date.now() },
                ],
                initialMessages: [],
              },
            },
          },
        ],
      },
    };
    // Standalone SessionStorage has no product Turn FK. Seed its immutable
    // append as if a prior projection committed but its receipt was lost.
    const prior = new PostgresPiSessionStorage({
      database: db,
      tenantId,
      sessionId,
      projectedMutationId: appendFact.factId,
    });
    if (appendFact.operation.kind !== "append_items") throw new Error("Fixture must append Items");
    await prior.appendItems(appendFact.operation.items);
    await projector.project(appendFact);
    const firstResult = await storage.getLog();
    const receipt = await db
      .selectFrom("pi_session_mutation_results")
      .select("result")
      .where("mutation_id", "=", appendFact.factId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(receipt.result).length).toBeLessThan(300);
    const logResult = await db
      .selectFrom("pi_session_log")
      .select("mutation_result")
      .where("mutation_id", "=", appendFact.factId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(logResult.mutation_result)).not.toContain("payload-");
    await down(db as unknown as Kysely<unknown>);
    const expanded = await db
      .selectFrom("pi_session_mutation_results")
      .select("result")
      .where("mutation_id", "=", appendFact.factId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(expanded.result)).toContain("payload-");
    await up(db as unknown as Kysely<unknown>);
    expect(
      await db
        .selectFrom("pi_session_mutation_results")
        .select("result")
        .where("mutation_id", "=", appendFact.factId)
        .executeTakeFirstOrThrow(),
    ).toEqual(receipt);
    expect(await storage.getLog()).toEqual(firstResult);
    await db
      .deleteFrom("pi_session_mutation_results")
      .where("mutation_id", "=", appendFact.factId)
      .execute();
    await projector.project(appendFact); // receipt TTL/ACK loss, immutable log wins
    expect(await storage.getLog()).toEqual(firstResult);
    expect(await storage.getLog()).toHaveLength(2);
  } finally {
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30_000);
