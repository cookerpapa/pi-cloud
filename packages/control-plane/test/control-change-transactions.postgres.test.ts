import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { parseSessionControlChange } from "@pi-cloud/protocol";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
let admin: Kysely<Database>, db: Kysely<Database>;
const name = `control_tx_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  if (!endpoint) return;
  admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(endpoint);
  url.pathname = `/${name}`;
  db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
  await runMigrations(db, "up");
}, 60000);
afterAll(async () => {
  if (!db) return;
  await db.destroy();
  try {
    await sql`drop database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
});
async function fixture() {
  const tenant = await createPrivateTenant(db, {
    slug: randomUUID(),
    ownerDisplayName: "Control transactions",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "controls", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "controls",
    "elastic",
  );
  const run = await store.acceptTurn(session.sessionId, randomUUID(), { prompt: "fixture" });
  const changes = () =>
    db
      .selectFrom("outbox")
      .selectAll()
      .where("tenant_id", "=", tenant.tenantId)
      .orderBy("created_at")
      .execute();
  return { ...tenant, ...session, ...run, changes };
}
it.skipIf(!endpoint)(
  "coalesces transaction references, retains Steer hints and rolls back atomically",
  async () => {
    const f = await fixture();
    expect((await f.changes()).filter((r) => r.payload.entity === "input_queue")).toHaveLength(1);
    await db.deleteFrom("outbox").where("tenant_id", "=", f.tenantId).execute();
    await db.transaction().execute(async (tx) => {
      await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid,true)`.execute(
        tx,
      );
      await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
        tx,
      );
      await tx
        .updateTable("sessions")
        .set({ row_version: sql`row_version+1` })
        .where("id", "=", f.sessionId)
        .execute();
    });
    const [row] = await f.changes();
    expect(await f.changes()).toHaveLength(1);
    expect(parseSessionControlChange(row!.payload)).toMatchObject({
      factId: row!.id,
      steerPending: true,
    });
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
          tx,
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await f.changes()).toHaveLength(1);
    await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
      db,
    );
    expect(await f.changes()).toHaveLength(2);
  },
);
it.skipIf(!endpoint)(
  "keeps the last revision after waiting behind a concurrent Session mutation",
  async () => {
    const f = await fixture();
    await db.deleteFrom("outbox").where("tenant_id", "=", f.tenantId).execute();
    const locked = Promise.withResolvers<void>(),
      early = Promise.withResolvers<void>();
    let firstId = "",
      firstVersion = 0n;
    const a = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", f.sessionId)
        .forUpdate()
        .execute();
      locked.resolve();
      await early.promise;
      await tx
        .updateTable("sessions")
        .set({ row_version: sql`row_version+1` })
        .where("id", "=", f.sessionId)
        .execute();
    });
    const b = db.transaction().execute(async (tx) => {
      await locked.promise;
      await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
        tx,
      );
      const row = await tx
        .selectFrom("outbox")
        .select(["id", "payload"])
        .where("tenant_id", "=", f.tenantId)
        .executeTakeFirstOrThrow();
      firstId = row.id;
      firstVersion = BigInt(String(row.payload.version));
      early.resolve();
      await tx
        .updateTable("sessions")
        .set({ row_version: sql`row_version+1` })
        .where("id", "=", f.sessionId)
        .execute();
    });
    await Promise.all([a, b]);
    const rows = await f.changes();
    expect(rows).toHaveLength(2);
    const updated = rows.find((r) => r.id === firstId)!,
      concurrent = rows.find((r) => r.id !== firstId)!;
    expect(BigInt(String(concurrent.payload.version))).toBeGreaterThan(firstVersion);
    expect(BigInt(String(updated.payload.version))).toBeGreaterThan(
      BigInt(String(concurrent.payload.version)),
    );
  },
);
it.skipIf(!endpoint)(
  "does not notify duplicate Subagent upserts, but emits actual update and deletion",
  async () => {
    const f = await fixture(),
      id = randomUUID();
    const insert = () =>
      db.insertInto("subagent_control_commands").values({
        id,
        tenant_id: f.tenantId,
        run_id: f.runId,
        partition: 0,
        command: { scope: { piSessionId: f.sessionId }, request: { action: "wait" } },
        delivered_at: null,
        input_consumed_at: null,
      });
    const original = await insert().returning("revision").executeTakeFirstOrThrow();
    const refs = async () =>
      (await f.changes()).filter((r) => r.payload.entity === "subagent_command");
    expect(await refs()).toHaveLength(1);
    for (let n = 0; n < 5; n++) {
      const retry = await insert()
        .onConflict((c) =>
          c.column("id").doUpdateSet({ id: sql.ref("subagent_control_commands.id") }),
        )
        .returning("revision")
        .executeTakeFirstOrThrow();
      expect(retry.revision).toBe(original.revision);
    }
    expect(await refs()).toHaveLength(1);
    const changed = await db
      .updateTable("subagent_control_commands")
      .set({ delivered_at: new Date() })
      .where("id", "=", id)
      .returning("revision")
      .executeTakeFirstOrThrow();
    expect(BigInt(changed.revision)).toBeGreaterThan(BigInt(original.revision));
    expect(await refs()).toHaveLength(2);
    await db.deleteFrom("subagent_control_commands").where("id", "=", id).execute();
    expect(await refs()).toHaveLength(3);
  },
);

it.skipIf(!endpoint)(
  "does not reuse a coalescing identity across commit, rollback or a restored reference",
  async () => {
    const f = await fixture();
    await db.deleteFrom("outbox").where("tenant_id", "=", f.tenantId).execute();
    await db.connection().execute(async (connection) => {
      const currentMarker = async (cx: typeof connection) =>
        (
          await sql<{
            id: string | null;
          }>`select nullif(current_setting('pi_cloud.control_transaction',true),'') id`.execute(cx)
        ).rows[0]!.id;
      let first: string | null = null;
      await connection.transaction().execute(async (tx) => {
        await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
          tx,
        );
        first = await currentMarker(tx);
        expect(first).toMatch(/^[a-f0-9-]{36}$/);
      });
      expect(await currentMarker(connection)).toBeNull();
      // Retained/restored published rows keep their payload and original marker.
      await connection
        .updateTable("outbox")
        .set({ published_at: new Date() })
        .where("tenant_id", "=", f.tenantId)
        .execute();
      await expect(
        connection.transaction().execute(async (tx) => {
          await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
            tx,
          );
          expect(await currentMarker(tx)).not.toBe(first);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await currentMarker(connection)).toBeNull();
      await connection.transaction().execute(async (tx) => {
        await sql`savepoint before_control`.execute(tx);
        await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
          tx,
        );
        const abandoned = await currentMarker(tx);
        await sql`rollback to savepoint before_control`.execute(tx);
        expect(await currentMarker(tx)).toBeNull();
        await sql`select pi_cloud_input_queue_change(${f.tenantId}::uuid,${f.sessionId}::uuid)`.execute(
          tx,
        );
        expect(await currentMarker(tx)).not.toBe(abandoned);
        expect(await currentMarker(tx)).not.toBe(first);
      });
      expect(await currentMarker(connection)).toBeNull();
      const rows = await connection
        .selectFrom("outbox")
        .selectAll()
        .where("tenant_id", "=", f.tenantId)
        .execute();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.control_transaction)).size).toBe(2);
      const retained = rows.find((r) => r.control_transaction === first);
      expect(retained).toBeDefined();
      expect(retained!.published_at).not.toBeNull();
    });
  },
);
