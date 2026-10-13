import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { createDatabase } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { insertHistoricalDurableSession } from "./fixtures/historical-turn.ts";

it("requires drained owners and preserves Worker identities, fences and credential references", async () => {
  const admin = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 1,
  });
  const name = `worker_cutover_${randomUUID().replaceAll("-", "")}`;
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
    await migrate("183_native_inputs_and_run_record");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Worker cutover",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({
      name: "Worker cutover",
      source: { kind: "empty" },
    });
    const session = await insertHistoricalDurableSession(db, { ...tenant, ...project });
    const run = await store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "retained input",
    });
    const worker = randomUUID(),
      boot = randomUUID(),
      lease = randomUUID(),
      credential = randomUUID();
    await sql`insert into sandboxes(id,supervisor_id,boot_id,state,max_concurrent_sessions)
      values(${worker}::uuid,${worker},${boot}::uuid,'ready',2);
    `.execute(db);
    await sql`insert into supervisor_hosts(supervisor_id,maximum_capacity,management_base_url,created_at,updated_at)
      values(${worker},2,'http://127.0.0.1:4100/',now(),now())`.execute(db);
    await sql`insert into supervisor_boot_credentials(credential_id,credential_sha256,provision_request_id,
      sandbox_id,supervisor_id,boot_id,created_at,expires_at)
      values(${credential}::uuid,${"a".repeat(64)},${randomUUID()}::uuid,${worker}::uuid,
        ${worker},${boot}::uuid,now(),now()+interval '1 hour')`.execute(db);
    const beforeCredential =
      await sql`select * from supervisor_boot_credentials where credential_id=${credential}::uuid`.execute(
        db,
      );
    await expect(migrate("184_worker_claim_schema")).rejects.toThrow(
      "Drain Runs, owners and seals",
    );
    expect((await sql`select to_regclass('workers') as worker`.execute(db)).rows).toEqual([
      { worker: null },
    ]);

    await sql`update pi_sessions set lease_epoch=3 where tenant_id=${tenant.tenantId}::uuid and id=${session.sessionId}`.execute(
      db,
    );
    await sql`insert into session_leases(tenant_id,pi_session_id,lease_id,sandbox_id,fencing_token,valid_until)
      values(${tenant.tenantId}::uuid,${session.sessionId},${lease}::uuid,${worker}::uuid,3,now()+interval '60 seconds')`.execute(
      db,
    );
    await sql`update runs set state='completed',settled_at=now(),ready_at=null,worker_id=${worker}::uuid,
      lease_id=${lease}::uuid,fencing_token=3,execution_released_at=now() where id=${run.runId}::uuid`.execute(
      db,
    );
    await expect(migrate("184_worker_claim_schema")).rejects.toThrow(
      "Drain Runs, owners and seals",
    );
    await sql`update session_leases set released_at=now() where lease_id=${lease}::uuid`.execute(
      db,
    );
    await expect(migrate("184_worker_claim_schema")).rejects.toThrow(
      "Drain Runs, owners and seals",
    );
    await sql`update session_leases set writer_sealed_at=now(),writer_seal_offset=42 where lease_id=${lease}::uuid`.execute(
      db,
    );
    await sql`update runs set output_sealed_at=now(),output_seal_offset=42 where id=${run.runId}::uuid`.execute(
      db,
    );
    await migrate("184_worker_claim_schema");

    expect(
      await db
        .selectFrom("workers")
        .select(["id", "supervisor_id", "boot_id", "state"])
        .where("id", "=", worker)
        .executeTakeFirst(),
    ).toEqual({ id: worker, supervisor_id: worker, boot_id: boot, state: "ready" });
    const afterCredential = await db
      .selectFrom("supervisor_boot_credentials")
      .selectAll()
      .where("credential_id", "=", credential)
      .executeTakeFirstOrThrow();
    const { sandbox_id: oldOwner, ...oldCredential } = beforeCredential.rows[0] as Record<
      string,
      unknown
    >;
    expect(afterCredential).toEqual({ ...oldCredential, worker_id: oldOwner });
    expect(
      await db
        .selectFrom("session_leases")
        .select(["worker_id", "fencing_token", "writer_seal_offset"])
        .where("lease_id", "=", lease)
        .executeTakeFirst(),
    ).toEqual({ worker_id: worker, fencing_token: "3", writer_seal_offset: "42" });
    expect(
      (
        await sql<{
          lease_epoch: string;
          unsealed_runs: string;
        }>`select lease_epoch::text,unsealed_runs::text from pi_sessions where id=${session.sessionId}`.execute(
          db,
        )
      ).rows[0],
    ).toEqual({ lease_epoch: "3", unsealed_runs: "0" });
    expect(
      await db
        .selectFrom("runs")
        .select(["input_text", "worker_id", "lease_id"])
        .where("id", "=", run.runId)
        .executeTakeFirst(),
    ).toEqual({ input_text: "retained input", worker_id: worker, lease_id: lease });
    const names = await sql<{
      name: string | null;
    }>`select to_regclass(v)::text as name from unnest(array['sandboxes','sandbox_retirements']) v`.execute(
      db,
    );
    expect(names.rows).toEqual([{ name: null }, { name: null }]);
    const columns = await sql<{
      table_name: string;
      column_name: string;
    }>`select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('pi_sessions','session_leases','supervisor_connections','supervisor_boot_credentials','worker_retirements','active_execution_scopes')`.execute(
      db,
    );
    expect(
      columns.rows
        .filter((r) => r.table_name === "pi_sessions")
        .map((r) => r.column_name)
        .sort(),
    ).toEqual(["id", "lease_epoch", "session_hash", "tenant_id", "unsealed_runs"]);
    expect(columns.rows.some((r) => r.column_name === "sandbox_id")).toBe(false);
    expect(
      (
        await sql`select indexname from pg_indexes where indexname='run_transitions_run_history'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);

    await expect(
      db
        .updateTable("session_leases")
        .set({ worker_id: randomUUID() })
        .where("lease_id", "=", lease)
        .execute(),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db
        .updateTable("supervisor_boot_credentials")
        .set({ boot_id: randomUUID() })
        .where("credential_id", "=", credential)
        .execute(),
    ).rejects.toMatchObject({ code: "23503" });
    await db
      .insertInto("session_leases")
      .values({
        tenant_id: tenant.tenantId,
        pi_session_id: session.sessionId,
        lease_id: randomUUID(),
        worker_id: worker,
        fencing_token: "4",
        valid_until: new Date(Date.now() + 60_000),
      })
      .execute();
    await expect(
      db
        .insertInto("session_leases")
        .values({
          tenant_id: tenant.tenantId,
          pi_session_id: session.sessionId,
          lease_id: randomUUID(),
          worker_id: worker,
          fencing_token: "5",
          valid_until: new Date(Date.now() + 60_000),
        })
        .execute(),
    ).rejects.toMatchObject({ code: "23505" });
  } finally {
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
}, 60_000);
