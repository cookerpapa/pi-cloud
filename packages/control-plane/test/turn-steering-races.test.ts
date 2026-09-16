import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase } from "@pi-cloud/database";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { TurnSteeringService } from "../src/turn-steering-service.ts";
import { TurnSteerBackendError } from "../src/turn-steer.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";

it.each(["late-error", "late-ambiguous", "late-success", "winner-failed", "still-unknown"])(
  "keeps the durable Steer outcome when another API replica finishes first (%s)",
  async (scenario) => {
    const engine = await PGlite.create();
    const server = new PGLiteSocketServer({
      db: engine,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 4,
    });
    await server.start();
    const db = createDatabase({
      connectionString: `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 4,
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let first: Promise<unknown> | undefined;
    try {
      // Isolate the already-accepted control row. Target admission and Worker
      // effect deduplication have separate tests; these replies race a PG commit.
      await sql`create table turn_control_requests (
        id uuid primary key, tenant_id uuid, session_id uuid, turn_id uuid,
        target_run_id uuid, idempotency_key text, kind text, state text,
        request_sha256 text, payload jsonb, created_at timestamptz,
        dispatched_at timestamptz, acknowledged_at timestamptz,
        completed_at timestamptz, failure_code text, attempts integer, available_at timestamptz
      )`.execute(db);
      const tenantId = randomUUID(),
        sessionId = randomUUID(),
        turnId = randomUUID(),
        runId = randomUUID(),
        id = randomUUID();
      const text = "Inspect the current counters.";
      await db
        .insertInto("turn_control_requests")
        .values({
          id,
          tenant_id: tenantId,
          session_id: sessionId,
          turn_id: turnId,
          target_run_id: runId,
          idempotency_key: "shared-key",
          kind: "steer",
          state: "pending",
          request_sha256: createHash("sha256")
            .update(JSON.stringify({ schemaVersion: 1, kind: "turn.steer", text }))
            .digest("hex"),
          payload: {
            text,
            projectId: randomUUID(),
            workspaceId: randomUUID(),
            attemptId: randomUUID(),
            sandboxId: randomUUID(),
          },
          created_at: new Date("2026-09-16T00:00:00Z"),
          attempts: 0,
          available_at: new Date("2026-09-16T00:00:00Z"),
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .execute();
      const identity = { tenantId } as TenantRequestIdentity;
      const late = new TurnSteeringService({
        database: db,
        clock: () => new Date("2026-09-16T00:01:00Z"),
        backendFactory: async () => ({
          steer: async () => {
            entered.resolve();
            await release.promise;
            if (scenario === "late-error")
              throw new TurnSteerBackendError("invalid_state", "Old runtime retired", false);
            if (scenario === "late-ambiguous" || scenario === "still-unknown")
              throw new TurnSteerBackendError("connection_lost", "Transport lost", true, true);
          },
        }),
      });
      const winner = new TurnSteeringService({
        database: db,
        clock: () => new Date("2026-09-16T00:00:01Z"),
        backendFactory: async () => ({
          steer: async () => {
            if (scenario === "winner-failed")
              throw new TurnSteerBackendError("invalid_state", "Run ended", false);
            if (scenario === "still-unknown")
              throw new TurnSteerBackendError("connection_lost", "Transport lost", true, true);
          },
        }),
      });
      first = late
        .deliver(identity, sessionId, turnId, "shared-key", { text })
        .catch((error) => error);
      await entered.promise;
      const second = await winner
        .deliver(identity, sessionId, turnId, "shared-key", { text })
        .catch((error) => error);
      release.resolve();
      const result = await first;
      if (scenario === "still-unknown") {
        expect(second).toMatchObject({ code: "steer_transport_unavailable" });
        expect(result).toMatchObject({ code: "steer_transport_unavailable" });
      } else if (scenario === "winner-failed") {
        expect(second).toMatchObject({ code: "conflict" });
        expect(result).toMatchObject({ code: "conflict" });
      } else {
        expect(second).toMatchObject({
          state: "delivered",
          deliveredAt: "2026-09-16T00:00:01.000Z",
        });
        expect(result).toEqual(second);
      }
      const stored = await db
        .selectFrom("turn_control_requests")
        .select(["state", "completed_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({
        state:
          scenario === "still-unknown"
            ? "dispatched"
            : scenario === "winner-failed"
              ? "failed"
              : "completed",
        completed_at: scenario === "still-unknown" ? null : new Date("2026-09-16T00:00:01Z"),
      });
      // Replaying an accepted terminal request must not contact a retired
      // runtime or turn a durable failure into a second attempt at the effect.
      if (scenario !== "still-unknown") {
        let calls = 0;
        const replay = new TurnSteeringService({
          database: db,
          backendFactory: async () => {
            calls++;
            throw new Error("Terminal request reached the Worker");
          },
        });
        const repeated = await replay
          .deliver(identity, sessionId, turnId, "shared-key", { text })
          .catch((error) => error);
        expect(repeated).toMatchObject(
          scenario === "winner-failed"
            ? { code: "conflict" }
            : { state: "delivered", deliveredAt: "2026-09-16T00:00:01.000Z", replayed: true },
        );
        expect(calls).toBe(0);
      }
    } finally {
      release.resolve();
      await first;
      await db.destroy();
      await server.stop();
      await engine.close();
    }
  },
);
