import { randomUUID } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sql, type Kysely } from "kysely";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from "vitest";
import { createDatabase, runMigrations, type Database } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("one-Run identity cutover", () => {
  let admin: Kysely<Database>,
    db: Kysely<Database>,
    name: string,
    tenantId: string,
    runId: string,
    sessionId: string,
    oldAttemptId: string,
    store: ControlPlaneStore;
  beforeAll(() => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
  });
  beforeEach(async () => {
    name = `pi_run_cutover_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    const migrated = await new Migrator({
      db,
      provider: migrationProvider,
      allowUnorderedMigrations: true,
    }).migrateTo("144_ready_run_admission");
    if (migrated.error) throw migrated.error;
    const tenant = await createPrivateTenant(db, {
      slug: "cutover",
      ownerDisplayName: "Migration test",
    });
    tenantId = tenant.tenantId;
    store = new ControlPlaneStore({ database: db, ...tenant });
    const p = await store.createProject({ name: "retained", source: { kind: "empty" } }),
      s = await store.createSession(p.projectId, p.workspaceId, "retained", "elastic");
    sessionId = s.sessionId;
    const native = new PostgresPiSessionStorage({ database: db, tenantId, sessionId });
    await native.appendEntry(
      {
        id: randomUUID(),
        type: "message",
        message: { role: "user", content: "retain this native history", timestamp: Date.now() },
      },
      "main",
    );
    runId = randomUUID();
    const turnId = randomUUID();
    // Seed the prior schema, not a compatibility branch in the current API.
    await sql`insert into turns(id,tenant_id,session_id,state,input_kind,input_text,
      model_profile_id,provider,model_id,thinking_level,credential_binding_id,credential_binding_version)
      select ${turnId}::uuid,tenant_id,${sessionId}::uuid,'queued','prompt','retained input',id,
        provider,model_id,default_thinking_level,credential_binding_id,credential_binding_version
      from model_profiles where tenant_id=${tenantId}::uuid and id=${tenant.defaultModelProfileId}::uuid`.execute(
      db,
    );
    await sql`insert into runs(id,tenant_id,project_id,workspace_id,session_id,turn_id,environment_version_id,
        idempotency_key,mailbox_position,request_sha256,available_at,state)
      values(${runId}::uuid,${tenantId}::uuid,${p.projectId}::uuid,${p.workspaceId}::uuid,
        ${sessionId}::uuid,${turnId}::uuid,${p.environment.environmentVersionId}::uuid,
        'historical',1,${"a".repeat(64)},now(),'queued')`.execute(db);
    await sql`update sessions set next_mailbox_position=2 where id=${sessionId}::uuid`.execute(db);
    oldAttemptId = randomUUID();
    const workerId = randomUUID(),
      leaseId = randomUUID();
    await db
      .insertInto("sandboxes")
      .values({
        id: workerId,
        supervisor_id: workerId,
        boot_id: randomUUID(),
        state: "ready",
        max_concurrent_sessions: 1,
      })
      .execute();
    await sql`insert into run_attempts(id,tenant_id,run_id,attempt_number,state,claim_owner_id,
      claim_expires_at,sandbox_id,lease_id,fencing_token,settled_at,execution_released_at,
      native_output_drained,output_seal_id,output_sealed_at,output_seal_offset,
      output_first_topic,output_first_partition,output_first_offset,output_publication)
      values(${oldAttemptId}::uuid,${tenantId}::uuid,${runId}::uuid,1,'completed',${workerId},
        now()+interval '60 seconds',${workerId}::uuid,${leaseId}::uuid,1,now(),now(),true,
        gen_random_uuid(),now(),5,'pi-cloud.execution-log.v9',0,3,'{}')`.execute(db);
    await sql`update runs set state='completed',settled_at=now(),stop_reason='stop',
        current_attempt_id=${oldAttemptId}::uuid,attempt_count=1 where id=${runId}::uuid`.execute(
      db,
    );
    await sql`update turns set state='completed',settled_at=now(),stop_reason='stop' where id=${turnId}::uuid`.execute(
      db,
    );
    await sql`insert into run_attempt_transitions(id,tenant_id,run_id,attempt_id,from_state,to_state,reason)
        values(gen_random_uuid(),${tenantId}::uuid,${runId}::uuid,${oldAttemptId}::uuid,null,'claimed','run_claimed'),
          (gen_random_uuid(),${tenantId}::uuid,${runId}::uuid,${oldAttemptId}::uuid,'claimed','running','execution_admitted');`.execute(
      db,
    );
  }, 60000);
  afterEach(async () => {
    await db?.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
  });
  afterAll(async () => {
    await admin?.destroy();
  });
  it("preserves native history and closed Run evidence without an Attempt authority", async () => {
    const before = await db.selectFrom("pi_session_log").selectAll().execute();
    await runMigrations(db, "up");
    expect(await db.selectFrom("pi_session_log").selectAll().execute()).toEqual(before);
    expect(
      await db
        .selectFrom("runs")
        .select([
          "id",
          "state",
          "output_first_offset",
          "output_seal_offset",
          "native_output_drained",
        ])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: runId,
      state: "completed",
      output_first_offset: "3",
      output_seal_offset: "5",
      native_output_drained: true,
    });
    expect(
      (
        await sql<{
          table: string | null;
        }>`select to_regclass('run_attempts')::text as "table"`.execute(db)
      ).rows[0]!.table,
    ).toBeNull();
    expect((await store.getRun(runId)).transitions).toEqual([
      expect.objectContaining({ fromState: "queued", toState: "running" }),
    ]);
    const next = await store.acceptTurn(sessionId, "next", { prompt: "continue" });
    expect(next.runId).not.toBe(runId);
  });
  it("rejects queued input before making any schema changes", async () => {
    await sql`update runs set state='queued',settled_at=null where id=${runId}::uuid`.execute(db);
    await expect(runMigrations(db, "up")).rejects.toThrow("Drain inputs, owners and seals");
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int n from information_schema.columns where table_name='runs' and column_name='output_sealed_at'`.execute(
          db,
        )
      ).rows[0]!.n,
    ).toBe(0);
  });
  it("rejects multiple historical executions instead of silently discarding one", async () => {
    await sql`insert into run_attempts(id,tenant_id,run_id,attempt_number,state,claim_owner_id,claim_expires_at,settled_at,output_sealed_at)
      values(gen_random_uuid(),${tenantId}::uuid,${runId}::uuid,2,'completed','test',now()+interval '60 seconds',now(),now())`.execute(
      db,
    );
    await expect(runMigrations(db, "up")).rejects.toThrow("Multiple historical Attempts");
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int n from run_attempts where run_id=${runId}::uuid`.execute(db)
      ).rows[0]!.n,
    ).toBe(2);
  });
});
