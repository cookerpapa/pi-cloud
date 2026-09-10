import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { CompiledQuery, sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { expect, it } from "vitest";
import { PostgresPiSessionStorage } from "../src/postgres-session-storage.ts";

const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;

it.skipIf(!external)(
  "uses parent-key lookups rather than rescanning a long Session at every hop",
  async () => {
    const admin = new Pool({ connectionString: external, max: 1 });
    const name = `pi_ancestry_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${name}"`);
    const url = new URL(external!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    try {
      await runMigrations(db, "up");
      const tenant = randomUUID(),
        sessionId = randomUUID(),
        prefix = `pc-${randomUUID()}-`;
      await db.insertInto("tenants").values({ id: tenant, slug: "ancestry-plan" }).execute();
      let compiled: CompiledQuery | undefined;
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          const query = db.getExecutor().compileQuery(node, queryId);
          if (query.sql.includes("with recursive")) compiled = query;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      });
      const storage = await PostgresPiSessionStorage.create({
        database: measured,
        tenantId: tenant,
        sessionId,
      });
      // Synthetic projection fixture, not a claim of model/context-token throughput.
      await sql`insert into pi_session_entries(tenant_id,session_id,id,seq,parent_id,type,custom_type,timestamp_ms,payload,turn_id)
      select ${tenant}::uuid,${sessionId},${prefix}||i::text,i,
        case when i=1 then null else ${prefix}||(i-1)::text end,
        'custom','state',1,jsonb_build_object('id',${prefix}||i::text,'type','custom','customType','state','data','x'),null
      from generate_series(1,2000) i`.execute(db);
      await sql`analyze pi_session_entries`.execute(db);
      const entries = await storage.findEntriesOnBranch({
        start: `${prefix}2000`,
        stopAtType: "compaction",
        order: "newestFirst",
      });
      expect(entries).toHaveLength(2000);
      expect(entries[0]?.id).toBe(`${prefix}2000`);
      expect(entries.at(-1)?.id).toBe(`${prefix}1`);
      const explanation = await db.executeQuery(
        CompiledQuery.raw(`explain (analyze,format json) ${compiled!.sql}`, [
          ...compiled!.parameters,
        ]),
      );
      const nodes: Record<string, unknown>[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (value && typeof value === "object") {
          const node = value as Record<string, unknown>;
          if (node["Node Type"]) nodes.push(node);
          Object.values(node).forEach(visit);
        }
      };
      visit(explanation.rows);
      expect(
        nodes.filter((n) => n["Node Type"] === "Recursive Union").map((n) => n["Actual Rows"]),
      ).toEqual([2000]);
      const repeatedReads = nodes.filter(
        (n) => n["Relation Name"] === "pi_session_entries" && Number(n["Actual Loops"]) > 100,
      );
      expect(repeatedReads.length).toBeGreaterThan(0);
      for (const node of repeatedReads) {
        expect(node["Node Type"]).toMatch(/Index/);
        expect(node["Index Cond"]).toMatch(/\bid = (?:branch|child)\.parent_id/);
        expect(Number(node["Rows Removed by Filter"] ?? 0)).toBe(0);
      }
    } finally {
      await db.destroy();
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  },
  30_000,
);
