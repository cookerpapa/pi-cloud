import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { expect, it } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { startNativeInputAgent } from "./native-input-fixture.ts";

it("releases cloud admission locks before native delivery and tolerates Tool binding references", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 5,
  });
  let agent: Awaited<ReturnType<typeof startNativeInputAgent>> | undefined;
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "admission",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "test", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "test",
      "elastic",
    );
    const root = await store.acceptTurn(session.sessionId, "root", { prompt: "work" });
    agent = await startNativeInputAgent(db, tenant.tenantId, root);
    const backend = agent.backend;
    const queue = new QueuedInputService({
      database: db,
      backendFactory: async () => ({
        humanInput: async (command) => {
          // Another transaction can lock the Run/Session while the RPC is running.
          await db.transaction().execute(async (tx) => {
            await sql`set local lock_timeout='1s'`.execute(tx);
            await tx
              .selectFrom("runs")
              .select("id")
              .where("id", "=", root.runId)
              .forNoKeyUpdate()
              .execute();
            await tx
              .selectFrom("sessions")
              .select("id")
              .where("id", "=", root.sessionId)
              .forNoKeyUpdate()
              .execute();
          });
          return backend.humanInput(command);
        },
      }),
    });
    const accepted = await db.transaction().execute(async (tx) => {
      await tx.selectFrom("runs").select("id").where("id", "=", root.runId).forKeyShare().execute();
      return queue.accept(store, tenant.tenantId, session.sessionId, "steer", {
        prompt: "direction",
        whenBusy: "steer",
      });
    });
    expect(accepted).toMatchObject({ kind: "input", runId: root.runId, delivery: "steer" });
  } finally {
    await agent?.close();
    await db.destroy();
  }
}, 30000);
