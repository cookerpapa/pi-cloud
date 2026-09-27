import { randomUUID } from "node:crypto";
import { CompiledQuery, sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPiSessionStorage, rebuildPostgresPiSessionProjections } from "../src/index.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("indexed native log and current operations", () => {
  const name = `pi_log_contract_${randomUUID().replaceAll("-", "")}`;
  const tenantId = randomUUID(),
    otherTenant = randomUUID();
  let admin: ReturnType<typeof createDatabase>, db: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    await runMigrations(db, "up");
    await db
      .insertInto("tenants")
      .values([
        { id: tenantId, slug: tenantId },
        { id: otherTenant, slug: otherTenant },
      ])
      .execute();
  }, 60000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      try {
        await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  });

  const start = (id: string, seq: number, lane = "main") => ({
    id,
    seq,
    lane,
    timestamp: seq,
    type: "operation_started",
    sourceLeafId: null,
    intent: { kind: "run", originalPrompt: [], initialMessages: [] },
  });
  const finish = (runId: string, seq: number, lane = "main") => ({
    id: `finish-${seq}`,
    seq,
    lane,
    timestamp: seq,
    type: "operation_finished",
    runId,
    outcome: "completed",
  });
  function row(
    sessionId: string,
    record: ReturnType<typeof start> | ReturnType<typeof finish>,
    tenant = tenantId,
  ) {
    return {
      tenant_id: tenant,
      session_id: sessionId,
      seq: record.seq,
      kind: "record",
      payload: { turnId: null, record },
      append_id: null,
    };
  }
  it("settles a whole batch independent of physical insert order and rolls state back with its log", async () => {
    const sessionId = randomUUID();
    const native = await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
    // Same semantic sequence, reverse physical VALUES order: transition-table
    // processing must not leave a start open merely because its finish arrived first.
    await db
      .insertInto("pi_session_log")
      .values([row(sessionId, finish("a", 2)), row(sessionId, start("a", 1))])
      .execute();
    expect(await native.findOpenOperations("main", { limit: 2 })).toEqual([]);
    await db
      .insertInto("pi_session_log")
      .values([row(sessionId, start("b", 3)), row(sessionId, start("c", 4))])
      .execute();
    expect((await native.findOpenOperations("main", { limit: 2 })).map((r) => r.id)).toEqual([
      "c",
      "b",
    ]);
    await db
      .insertInto("pi_session_log")
      .values(row(sessionId, finish("b", 5, "other")))
      .execute();
    expect(await native.findOpenOperations("main", { limit: 2 })).toHaveLength(2);
    await db
      .insertInto("pi_session_log")
      .values(row(sessionId, finish("b", 6)))
      .execute();
    expect((await native.findOpenOperations("main")).map((r) => r.id)).toEqual(["c"]);
    await expect(
      db.transaction().execute(async (tx) => {
        await tx
          .insertInto("pi_session_log")
          .values(row(sessionId, finish("c", 7)))
          .execute();
        expect(
          await tx
            .selectFrom("pi_session_open_operations")
            .select("seq")
            .where("session_id", "=", sessionId)
            .execute(),
        ).toEqual([]);
        throw new Error("rollback after current-state update");
      }),
    ).rejects.toThrow("rollback after");
    expect((await native.findOpenOperations("main")).map((r) => r.id)).toEqual(["c"]);
    expect(await native.getLog()).toHaveLength(6);
    await db.deleteFrom("pi_session_open_operations").where("session_id", "=", sessionId).execute();
    await rebuildPostgresPiSessionProjections(db, { tenantId, sessionId });
    expect((await native.findOpenOperations("main")).map((r) => r.id)).toEqual(["c"]);

    const other = await PostgresPiSessionStorage.create({
      database: db,
      tenantId: otherTenant,
      sessionId,
    });
    await db
      .insertInto("pi_session_log")
      .values(row(sessionId, start("c", 1), otherTenant))
      .execute();
    await db
      .insertInto("pi_session_log")
      .values(row(sessionId, finish("c", 7)))
      .execute();
    expect(await native.findOpenOperations("main")).toEqual([]);
    expect((await other.findOpenOperations("main")).map((r) => r.id)).toEqual(["c"]);
  });

  function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
    return [plan, ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)];
  }
  async function explain(query: CompiledQuery, mode: string) {
    await sql.raw(`set plan_cache_mode=${mode}`).execute(db);
    await sql.raw(`prepare native_plan as ${query.sql}`).execute(db);
    try {
      const result = await sql<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>`
        explain (analyze,buffers,timing off,format json) execute native_plan(${sql.join(query.parameters.map((v) => sql.lit(v)))})
      `.execute(db);
      return nodes(result.rows[0]!["QUERY PLAN"][0]!.Plan);
    } finally {
      await sql`deallocate native_plan`.execute(db);
      await sql`set plan_cache_mode=auto`.execute(db);
    }
  }
  it("bounds page, compacted ancestry and idle-operation reads under custom and generic plans", async () => {
    const captured: CompiledQuery[] = [];
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        captured.push(db.getExecutor().compileQuery(node, queryId));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    for (const count of [2000, 20000]) {
      const sessionId = randomUUID();
      const native = await PostgresPiSessionStorage.create({
        database: measured,
        tenantId,
        sessionId,
      });
      await sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload)
        select ${tenantId}::uuid,${sessionId},i,'entry',jsonb_build_object('lane','main','turnId',null,'entry',
          jsonb_build_object('id','e'||i,'seq',i,'timestamp',1,'parentId',case when i=1 then null else 'e'||(i-1) end,
            'type',case when i=${count - 64} then 'compaction' else 'custom' end,'customType','state',
            'summary','fixture','retainedTail','[]'::jsonb,'tokensBefore',100,'data',md5(i::text)))
          from generate_series(1,${count}) i`.execute(db);
      await sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload)
        select ${tenantId}::uuid,${sessionId},${count}+i,'record',jsonb_build_object('turnId',null,'record',
          jsonb_build_object('id','r'||i,'seq',${count}+i,'timestamp',1,'lane','main',
            'type',case when i%2=1 then 'operation_started' else 'operation_finished' end,
            'runId','r'||(i-1),'intent',jsonb_build_object('kind','run','originalPrompt','[]'::jsonb,'initialMessages','[]'::jsonb),
            'sourceLeafId',null,'outcome','completed')) from generate_series(1,${count * 2}) i`.execute(
        db,
      );
      await sql`vacuum (analyze) pi_session_log`.execute(db);
      await sql`vacuum (analyze) pi_session_open_operations`.execute(db);
      captured.length = 0;
      expect(await native.findEntries({ limit: 40 })).toHaveLength(40);
      const page = captured[0]!;
      captured.length = 0;
      expect(
        await native.findEntriesOnBranch({ start: `e${count}`, stopAtType: "compaction" }),
      ).toHaveLength(65);
      const branch = captured[0]!;
      captured.length = 0;
      expect(await native.findOpenOperations("main", { limit: 2 })).toEqual([]);
      const open = captured[0]!;
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        const pageNodes = await explain(page, mode);
        const reads = pageNodes.filter((n) => n["Relation Name"] === "pi_session_log");
        expect(reads).toHaveLength(1);
        expect(reads[0]!["Node Type"]).toMatch(/Index/);
        expect(reads[0]!["Actual Rows"]).toBe(40);
        const branchNodes = await explain(branch, mode);
        expect(
          branchNodes
            .filter((n) => n["Node Type"] === "Recursive Union")
            .map((n) => n["Actual Rows"]),
        ).toEqual([65]);
        for (const read of branchNodes.filter(
          (n) => n["Relation Name"] === "pi_session_log" && Number(n["Actual Loops"]) > 10,
        )) {
          expect(read["Node Type"]).toMatch(/Index/);
          expect(read["Index Cond"]).toMatch(/id = (?:branch|child)\.parent_id/);
          expect(Number(read["Rows Removed by Filter"] ?? 0)).toBe(0);
        }
        const openNodes = await explain(open, mode);
        expect(
          openNodes
            .filter((n) => n["Relation Name"] === "pi_session_log")
            .every((n) => Number(n["Actual Loops"]) === 0),
        ).toBe(true);
      }
    }
  }, 60000);
});
