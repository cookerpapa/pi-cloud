import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { sql, type Kysely, type CompiledQuery } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { DurablePostgresProjection, PublishedDurableStorage } from "../src/durable/index.ts";

let admin: Pool, db: Kysely<Database>, name: string;
beforeAll(async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  admin = new Pool({ connectionString: endpoint, max: 1 });
  name = `submission_status_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(endpoint);
  url.pathname = `/${name}`;
  db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  await runMigrations(db, "up");
}, 60_000);
afterAll(async () => {
  await db?.destroy();
  await admin?.query(`drop database "${name}"`);
  await admin?.end();
});

async function seed(completed: number) {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await db.insertInto("tenants").values({ id: scope.tenantId, slug: scope.tenantId }).execute();
  await db
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(db, scope);
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      await projection.apply(batch);
    },
    waitProjected: async () => {},
  });
  const pending = [completed + 4, completed + 5];
  const writes: StorageWrite[] = [
    { type: "conversation", value: { id: 1 as never } },
    {
      type: "entry",
      value: {
        id: 2 as never,
        conversationId: 1 as never,
        kind: "pi.user",
        model: [{ role: "user", content: "Owned receipt fixture", timestamp: 0 }],
      },
    },
    {
      type: "entry",
      value: { id: 3 as never, conversationId: 1 as never, kind: "pi.assistant", model: [] },
    },
  ];
  for (let i = 0; i < completed; i++)
    writes.push({
      type: "submission",
      value: {
        id: (i + 4) as never,
        conversationId: 1 as never,
        type: "input",
        requestId: "done-" + i,
        status: "done",
        entry: 2 as never,
        answer: 3 as never,
      },
    });
  for (const id of pending)
    writes.push({
      type: "submission",
      value: {
        id: id as never,
        conversationId: 1 as never,
        type: "input",
        requestId: "queued-" + id,
        status: "queued",
      },
    });
  for (let i = 0; i < writes.length; i += 250)
    await store.commit(writes.slice(i, i + 250), context);
  await store.close(context);
  return { scope, projection, pending };
}

type Plan = {
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Actual Loops"?: number;
  Plans?: Plan[];
};
const walk = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(walk)];

it("uses the Submission status index with actual named custom/generic plans and preserves paging/receipts", async () => {
  const small = await seed(0),
    large = await seed(10_000);
  await sql`analyze pi_durable_owned_records`.execute(db);
  await sql`analyze pi_durable_current`.execute(db);
  for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
    await db.connection().execute(async (connection) => {
      await sql`set plan_cache_mode=${sql.lit(mode)}`.execute(connection);
      for (const f of [small, large]) {
        for (const status of ["queued", "placed"] as const) {
          let captured: CompiledQuery | undefined;
          const traced = connection.withPlugin({
            transformQuery({ node, queryId }) {
              captured = connection.getExecutor().compileQuery(node, queryId);
              return node;
            },
            async transformResult({ result }) {
              return result;
            },
          });
          const rows = await new DurablePostgresProjection(traced, f.scope).scan(
            { kind: "submission", fields: { status }, minId: 0 },
            3,
          );
          expect(rows.map((r) => r.value.id)).toEqual(status === "queued" ? f.pending : []);
          const query = captured!;
          const prepared = await sql<{
            name: string;
            generic_plans: string;
            custom_plans: string;
          }>`select name,generic_plans,custom_plans from pg_prepared_statements where statement=${query.sql}`.execute(
            connection,
          );
          expect(prepared.rows).toHaveLength(1);
          expect(
            Number(
              prepared.rows[0]![mode === "force_generic_plan" ? "generic_plans" : "custom_plans"],
            ),
          ).toBeGreaterThan(0);
          const args = query.parameters.map((value) => {
            expect(["string", "number"]).toContain(typeof value);
            return sql.lit(value as string | number);
          });
          const explain = await sql<{
            "QUERY PLAN": { Plan: Plan }[];
          }>`explain (analyze,format json) execute ${sql.id(prepared.rows[0]!.name)}(${sql.join(args)})`.execute(
            connection,
          );
          const nodes = walk(explain.rows[0]!["QUERY PLAN"][0]!.Plan);
          if (f === large)
            expect(
              nodes.some((n) => n["Index Name"] === "pi_durable_submission_status"),
              JSON.stringify({ mode, size: 10000, status, plan: explain.rows }),
            ).toBe(true);
          const examined = nodes
            .filter((n) => n["Relation Name"] === "pi_durable_records")
            .reduce(
              (n, p) =>
                n +
                ((p["Actual Rows"] ?? 0) + (p["Rows Removed by Filter"] ?? 0)) *
                  (p["Actual Loops"] ?? 1),
              0,
            );
          expect(
            examined,
            JSON.stringify({ mode, size: f === large ? 10000 : 0, status, nodes }),
          ).toBeLessThanOrEqual(f === large ? 2 : 5);
        }
      }
      await sql`reset plan_cache_mode`.execute(connection);
    });
  }
  const storage = await PublishedDurableStorage.open({
    projection: large.projection,
    publish: async (batch) => {
      await large.projection.apply(batch);
    },
    waitProjected: async () => {},
  });
  try {
    const first = await storage.scanSubmissions({ status: "queued" }, 1, undefined, context);
    const second = await storage.scanSubmissions({ status: "queued" }, 1, first.next, context);
    expect(first.items.map((x) => x.id)).toEqual([large.pending[0]]);
    expect(second.items.map((x) => x.id)).toEqual([large.pending[1]]);
    expect(second.next).toBeUndefined();
    if (first.items[0]?.status !== "queued" || first.items[0]?.type !== "input")
      throw new Error("Expected the queued input receipt");
    await storage.commit(
      [{ type: "submission", value: { ...first.items[0]!, status: "placed", entry: 2 as never } }],
      context,
    );
    await storage.flush();
    expect(
      (await storage.scanSubmissions({ status: "queued" }, 10, undefined, context)).items.map(
        (x) => x.id,
      ),
    ).toEqual([large.pending[1]]);
    expect(
      (await storage.scanSubmissions({ status: "placed" }, 10, undefined, context)).items.map(
        (x) => x.id,
      ),
    ).toEqual([large.pending[0]]);
    expect((await storage.submissionByRequest(1 as never, "done-0", context))?.status).toBe("done");
  } finally {
    await storage.close(context);
  }
}, 30_000);
