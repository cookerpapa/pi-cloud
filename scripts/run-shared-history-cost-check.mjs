// Isolated PostgreSQL cost comparison; no provider/VM/user conversation is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { createDatabase } from "../packages/database/src/index.ts";
import { migrationProvider } from "../packages/database/src/migrations/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { DurablePostgresProjection } from "../packages/pi-session-postgres/src/durable/index.ts";
import { captureNativePresentation } from "../packages/runtime-core/src/frozen-history.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
assert(endpoint, "Use the isolated PostgreSQL wrapper");
const out = resolve(process.argv[2]);
await mkdir(out, { recursive: true, mode: 0o700 });
const baseline = process.env.PI_CLOUD_HISTORY_COST_BASELINE;
assert(baseline, "Provide a read-only schema-203 source checkout with workspace dependencies");
const Before = (
  await import(
    pathToFileURL(
      resolve(baseline, "packages/pi-session-postgres/src/durable/postgres-projection.ts"),
    ).href
  )
).DurablePostgresProjection;
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
const report = { at: new Date().toISOString(), accepted: false, before: {}, after: {} };
const stats = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    samples: v.length,
    p50: v[Math.floor(v.length * 0.5)],
    p95: v[Math.floor(v.length * 0.95)],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
};
try {
  for (const [mode, Projection] of [
    ["before", Before],
    ["after", DurablePostgresProjection],
  ]) {
    const name = `history_cost_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint);
    url.pathname = "/" + name;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 3 });
    try {
      const migration = await new Migrator({
        db,
        provider: migrationProvider,
        allowUnorderedMigrations: true,
      }).migrateTo(
        mode === "before" ? "203_shared_native_entry_bodies" : "204_shared_native_history_bases",
      );
      if (migration.error) throw migration.error;
      for (const bytes of [768, 30 * 1024]) {
        const tenant = await createPrivateTenant(db, {
          slug: randomUUID(),
          ownerDisplayName: "Synthetic cost fixture",
        });
        const store = new ControlPlaneStore({ database: db, ...tenant });
        const project = await store.createProject({
          name: "Cost fixture",
          source: { kind: "empty" },
        });
        const session = await store.createSession(
          project.projectId,
          project.workspaceId,
          "Cost fixture",
          "elastic",
        );
        const run = await store.acceptTurn(session.sessionId, randomUUID(), {
          prompt: "Synthetic cost check",
        });
        const scope = { tenantId: tenant.tenantId, sessionId: session.sessionId };
        const projection = new Projection(db, scope, undefined, "references");
        await projection.apply({
          seq: 1,
          nextId: 2,
          writes: [{ type: "conversation", value: { id: 1 } }],
        });
        const write = [],
          read = [];
        let seq = 1,
          id = 2;
        const startLsn = (await sql`select pg_current_wal_insert_lsn()::text as lsn`.execute(db))
          .rows[0].lsn;
        for (let i = 0; i < 240; i++) {
          const batch = {
            seq: ++seq,
            nextId: id + 1,
            writes: [
              {
                type: "entry",
                value: {
                  id,
                  conversationId: 1,
                  kind: "pi.assistant",
                  model: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: String(i) + "x".repeat(bytes) }],
                      stopReason: "stop",
                      timestamp: 1,
                    },
                  ],
                },
              },
            ],
          };
          const origins = [
            { recordId: id, sessionId: session.sessionId, runId: run.runId, turnId: run.turnId },
          ];
          const at = performance.now();
          await db.transaction().execute(async (tx) => {
            await projection.applyIn(tx, batch, origins);
            if (mode === "after") await captureNativePresentation(tx, scope, seq);
          });
          if (i >= 40) write.push(performance.now() - at);
          const readAt = performance.now();
          const rows = await projection.scan(
            { kind: "entry", fields: { conversation: "1" }, descending: true, maxId: id },
            16,
          );
          assert(rows.length > 0);
          if (i >= 40) read.push(performance.now() - readAt);
          id++;
        }
        const wal = (
          await sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${startLsn}::pg_lsn)::text as bytes`.execute(
            db,
          )
        ).rows[0].bytes;
        report[mode][bytes] = { writeMs: stats(write), readMs: stats(read), walBytes: Number(wal) };
      }
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
    }
  }
  report.accepted = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  await admin.destroy();
}
