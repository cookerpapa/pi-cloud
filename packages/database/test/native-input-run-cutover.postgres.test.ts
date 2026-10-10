import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { createDatabase } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import {
  insertHistoricalPrompt,
  insertHistoricalDurableSession,
} from "./fixtures/historical-turn.ts";

it("requires drained ownership, consolidates frozen input and preserves tenant/FK boundaries", async () => {
  const admin = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 1,
  });
  const name = `native_input_cutover_${randomUUID().replaceAll("-", "")}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
  url.pathname = `/${name}`;
  const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  const migrate = async (target: string) => {
    const result = await new Migrator({
      db,
      provider: migrationProvider,
      allowUnorderedMigrations: true,
    }).migrateTo(target);
    if (result.error) throw result.error;
  };
  try {
    await migrate("182_conversation_activity_page");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Cutover",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Cutover", source: { kind: "empty" } });
    const session = await insertHistoricalDurableSession(db, { ...tenant, ...project });
    const old = await insertHistoricalPrompt(db, {
      ...tenant,
      ...project,
      sessionId: session.sessionId,
      modelProfileId: tenant.defaultModelProfileId,
      environmentVersionId: project.environment.environmentVersionId,
      prompt: "retained initial input",
    });
    await expect(migrate("183_native_inputs_and_run_record")).rejects.toThrow("Drain executions");
    await sql`update turns set state='completed',started_at=now(),settled_at=now() where id=${old.turnId}::uuid`.execute(
      db,
    );
    await db
      .updateTable("runs")
      .set({ state: "completed", ready_at: null, started_at: new Date(), settled_at: new Date() })
      .where("id", "=", old.runId)
      .execute();
    const returnId = randomUUID();
    await sql`insert into turn_control_requests(id,tenant_id,session_id,turn_id,target_run_id,idempotency_key,kind,state,request_sha256,payload,completed_at)
      values(${returnId}::uuid,${tenant.tenantId}::uuid,${session.sessionId}::uuid,${old.turnId}::uuid,${old.runId}::uuid,
        'old-return','cancel','completed',${"a".repeat(64)},'{"inputReturnPending":true}'::jsonb,now())`.execute(
      db,
    );
    await expect(migrate("183_native_inputs_and_run_record")).rejects.toThrow("Drain executions");
    await sql`update turn_control_requests set payload='{"inputReturnPending":false}'::jsonb where id=${returnId}::uuid`.execute(
      db,
    );
    await migrate("183_native_inputs_and_run_record");
    expect((await sql`select to_regclass('public.turns') as old`.execute(db)).rows).toEqual([
      { old: null },
    ]);
    const run = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", old.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      turn_id: old.turnId,
      input_text: "retained initial input",
      model_profile_id: tenant.defaultModelProfileId,
      state: "completed",
      worker_id: null,
    });
    for (const removed of [
      "queued_at",
      "sandbox_id",
      "queued_steer_id",
      "input_return_request_id",
      "last_heartbeat_at",
      "output_projected_offset",
      "conversation_base_seq",
    ])
      expect(removed in run).toBe(false);
    const foreign = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Other",
    });
    await expect(
      db
        .updateTable("runs")
        .set({ model_profile_id: foreign.defaultModelProfileId })
        .where("id", "=", run.id)
        .execute(),
    ).rejects.toThrow();
    await db
      .insertInto("session_terminal_events")
      .values({
        tenant_id: tenant.tenantId,
        session_id: session.sessionId,
        turn_id: old.turnId,
        seq: 1,
        agent_id: "root",
        run_id: old.runId,
        schema_version: 1,
        event_id: randomUUID(),
        type: "turn.completed",
        payload: { stopReason: "stop" },
        occurred_at: new Date(),
      })
      .execute();
    await db.deleteFrom("runs").where("id", "=", old.runId).execute();
    expect(
      await db
        .selectFrom("session_terminal_events")
        .selectAll()
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toEqual([]);
  } finally {
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
}, 60000);
