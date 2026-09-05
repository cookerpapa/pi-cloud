import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { expect, it } from "vitest";
import { PostgresPiSessionMutationProjector } from "../src/postgres-pi-session-mutation-projector.ts";
import type { AcceptedPiSessionMutationFact } from "../src/accepted-fact.ts";

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
  } finally {
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30_000);
