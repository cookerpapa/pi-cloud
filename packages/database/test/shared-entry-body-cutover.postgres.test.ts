import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { createDatabase, runMigrations } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { DurablePostgresProjection } from "../../pi-session-postgres/src/durable/postgres-projection.ts";
import { historyFingerprint } from "../../pi-session-postgres/src/durable/current-state.ts";
import type { DurableBatch } from "../../pi-session-postgres/src/durable/types.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "converts existing forks without losing native values or original replay fingerprints",
  async () => {
    const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
    const name = `entry_cutover_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      const before = await new Migrator({
        db,
        provider: migrationProvider,
        allowUnorderedMigrations: true,
      }).migrateTo("202_session_schedules");
      if (before.error) throw before.error;
      const tenant = randomUUID(),
        sessions = [randomUUID(), randomUUID()];
      await db.insertInto("tenants").values({ id: tenant, slug: tenant }).execute();
      const entry = {
        kind: "fixture.entry",
        data: { text: "nul:\0 lone:\ud800 中文", nested: { value: "retained" } },
        conversationId: 1 as never,
        id: 2 as never,
      };
      const batch: DurableBatch = {
        seq: 1 as never,
        nextId: 3,
        writes: [
          { type: "conversation", value: { id: 1 as never } },
          { type: "entry", value: entry },
        ],
      };
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ batch, origins: [] }))
        .digest("hex");
      const rows = batch.writes.map((write, ordinal) => ({
        ordinal,
        record_kind: write.type,
        record_id: String("value" in write ? write.value.id : 0),
        body: JSON.stringify(write),
        phase: null,
        cloud_origin: null,
      }));
      for (const session of sessions) {
        await db.insertInto("pi_sessions").values({ tenant_id: tenant, id: session }).execute();
        await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,
          write_count,history_write_count,history_fingerprint,current_hashes)
          values(${tenant}::uuid,${session},1,3,${fingerprint},2,2,${historyFingerprint(rows)},'{}')`.execute(
          db,
        );
        await sql`insert into pi_durable_log(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin)
          values ${sql.join(rows.map((r) => sql`(${tenant}::uuid,${session},1,${r.ordinal},${r.record_kind},${r.record_id},${r.body},null,null)`))}`.execute(
          db,
        );
      }
      await runMigrations(db, "up");
      expect(
        (await sql<{ n: number }>`select count(*)::int n from pi_history_bodies`.execute(db))
          .rows[0]!.n,
      ).toBe(1);
      expect(
        (await sql<{ fingerprint: string }>`select fingerprint from pi_durable_commits`.execute(db))
          .rows,
      ).toEqual([{ fingerprint }, { fingerprint }]);
      for (const sessionId of sessions) {
        const projection = new DurablePostgresProjection(
          db,
          { tenantId: tenant, sessionId },
          undefined,
          "references",
        );
        await projection.rebuild();
        expect((await projection.get(2))?.value).toEqual(entry);
        expect(await projection.apply(batch)).toBe(false);
      }
      const repeated = await runMigrations(db, "up");
      expect(repeated.results).toEqual([]);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60_000,
);
