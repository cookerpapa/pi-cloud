import { randomUUID } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sql, type Kysely } from "kysely";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations, type Database } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("dormant accounting retirement", () => {
  let admin: Kysely<Database>, db: Kysely<Database>, name: string;
  let tenant: Awaited<ReturnType<typeof createPrivateTenant>>;
  let project: Awaited<ReturnType<ControlPlaneStore["createProject"]>>;
  let session: Awaited<ReturnType<ControlPlaneStore["createSession"]>>;
  let accepted: Awaited<ReturnType<ControlPlaneStore["acceptTurn"]>>;
  beforeAll(() => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
  });
  beforeEach(async () => {
    name = `pi_retire_accounting_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    const result = await new Migrator({
      db,
      provider: migrationProvider,
      allowUnorderedMigrations: true,
    }).migrateTo("146_environment_validation_run_identity");
    if (result.error) throw result.error;
    tenant = await createPrivateTenant(db, {
      slug: "retirement",
      ownerDisplayName: "Retirement fixture",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    project = await store.createProject({ name: "preserve", source: { kind: "empty" } });
    session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "preserve",
      "elastic",
    );
    const storage = new PostgresPiSessionStorage({
      database: db,
      tenantId: tenant.tenantId,
      sessionId: session.sessionId,
    });
    await storage.appendEntry(
      {
        id: randomUUID(),
        type: "message",
        message: { role: "user", content: "preserve native history", timestamp: Date.now() },
      },
      "main",
    );
    accepted = await store.acceptTurn(session.sessionId, "fixture", { prompt: "accepted input" });
    await sql`update runs set state='cancelled',settled_at=now() where id=${accepted.runId}::uuid`.execute(
      db,
    );
    await sql`update turns set state='cancelled',settled_at=now() where id=${accepted.turnId}::uuid`.execute(
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

  it("removes only dormant structures and preserves execution limits and native history", async () => {
    const before = await db.selectFrom("pi_session_log").selectAll().execute();
    await runMigrations(db, "up");
    expect(await db.selectFrom("pi_session_log").selectAll().execute()).toEqual(before);
    expect(await db.selectFrom("runs").select("id").execute()).toHaveLength(1);
    for (const table of [
      "usage_ledger",
      "model_requests",
      "model_rates",
      "environment_operations",
    ]) {
      expect(
        (
          await sql<{
            relation: string | null;
          }>`select to_regclass(${table})::text as relation`.execute(db)
        ).rows[0]?.relation,
      ).toBeNull();
    }
    await expect(
      db
        .updateTable("tenant_runtime_policies")
        .set({ maximum_tool_calls_per_run: 0 })
        .where("tenant_id", "=", tenant.tenantId)
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each(["usage", "request", "environment", "queued"])(
    "refuses destructive cutover with %s data",
    async (kind) => {
      if (kind === "usage")
        await sql`insert into usage_ledger(id,tenant_id,session_id,turn_id,provider,model_id,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_amount)
      values(gen_random_uuid(),${tenant.tenantId}::uuid,${session.sessionId}::uuid,${accepted.turnId}::uuid,
      'fixture','fixture',1,1,0,0,0)`.execute(db);
      if (kind === "request")
        await sql`insert into model_requests(id,tenant_id,session_id,turn_id,run_id,model_profile_id,
      request_sequence,requested_provider,requested_model_id,state,reserved_input_tokens,reserved_output_tokens,
      reserved_cost_microusd,reservation_expires_at)
      values(gen_random_uuid(),${tenant.tenantId}::uuid,${session.sessionId}::uuid,${accepted.turnId}::uuid,
      ${accepted.runId}::uuid,${tenant.defaultModelProfileId}::uuid,1,'fixture','fixture','reserved',1,1,0,now())`.execute(
          db,
        );
      if (kind === "environment")
        await sql`insert into environment_operations(id,tenant_id,project_id,actor_user_id,kind,
      to_environment_version_id,idempotency_key,request_fingerprint)
      values(gen_random_uuid(),${tenant.tenantId}::uuid,${project.projectId}::uuid,${tenant.ownerUserId}::uuid,
      'create',${project.environment.environmentVersionId}::uuid,'history',${"a".repeat(64)})`.execute(
          db,
        );
      if (kind === "queued")
        await sql`update runs set state='queued',settled_at=null where id=${accepted.runId}::uuid`.execute(
          db,
        );
      await expect(runMigrations(db, "up")).rejects.toThrow(
        kind === "queued" ? "Drain Runs" : "Export historical",
      );
      expect(
        (
          await sql<{
            relation: string | null;
          }>`select to_regclass('usage_ledger')::text as relation`.execute(db)
        ).rows[0]?.relation,
      ).toBe("usage_ledger");
    },
  );
});
