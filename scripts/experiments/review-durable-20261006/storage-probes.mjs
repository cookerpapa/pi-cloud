// Isolated PostgreSQL characterization; never opens production configuration.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  PublishedDurableStorage,
  DurablePostgresProjection,
} from "@pi-cloud/pi-session-postgres/durable";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { appendNativeFixture } from "../../../packages/control-plane/test/fixtures/durable-native.ts";
import { readCanonicalPiTurnTranscripts } from "../../../packages/runtime-core/src/canonical-pi-conversation.ts";
import { ConversationTreeService } from "../../../packages/control-plane/src/conversation-tree-service.ts";

const fixture = await testPostgres();
const queries = [];
const historyReads = [];
const pool = new Pool({ connectionString: fixture.url, max: 1 });
pool.on("connect", (client) => {
  const query = client.query.bind(client);
  client.query = (...args) => {
    const result = query(...args);
    const source = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    if (source.includes("select l.body,r.fields,r.seq,c.committed_at") && result?.then)
      return result.then((value) => {
        historyReads.push({
          rows: value.rows.length,
          bytes: value.rows.reduce((n, row) => n + Buffer.byteLength(row.body), 0),
        });
        return value;
      });
    return result;
  };
});
const db = new Kysely({
  dialect: new PostgresDialect({ pool }),
  log(event) {
    if (event.level === "query") queries.push(event.query.sql);
  },
});
let preparedDb;
try {
  await runMigrations(db, "up");
  // A valid Tool-only final arrives without a model partial. Display coverage
  // can still precede the assistant even though the Tool checkpoint is durable.
  const owner = await createPrivateTenant(db, {
    slug: `review-${randomUUID()}`,
    ownerDisplayName: "Review",
  });
  const control = new ControlPlaneStore({ database: db, ...owner });
  const project = await control.createProject({ name: "Review", source: { kind: "empty" } });
  const conversation = await control.createSession(
    project.projectId,
    project.workspaceId,
    "Review",
    "elastic",
  );
  const accepted = await control.acceptTurn(conversation.sessionId, randomUUID(), {
    prompt: "sleep",
  });
  const activeScope = {
    tenantId: owner.tenantId,
    sessionId: conversation.sessionId,
    runId: accepted.runId,
    turnId: accepted.turnId,
  };
  const [call] = await appendNativeFixture(db, activeScope, [
    {
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call", name: "bash", arguments: { command: "sleep 30" } },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      ],
    },
  ]);
  const activeProjection = new DurablePostgresProjection(db, activeScope),
    activeHead = await activeProjection.head(),
    taskId = activeHead.nextId;
  await activeProjection.apply(
    {
      seq: activeHead.seq + 1,
      nextId: taskId + 1,
      writes: [
        {
          type: "task",
          value: {
            id: taskId,
            conversationId: 1,
            kind: "pi.tool",
            version: 1,
            input: { assistant: call.id, callId: "call" },
            background: false,
            abortRequested: false,
            state: {
              status: "running",
              checkpoint: {
                phase: "execute",
                arguments: { command: "sleep 30" },
                replay: "unsafe",
              },
            },
          },
        },
      ],
    },
    [
      {
        recordId: taskId,
        sessionId: activeScope.sessionId,
        runId: activeScope.runId,
        turnId: activeScope.turnId,
      },
    ],
  );
  const visible = [];
  for (const coverage of [0, activeHead.seq]) {
    await db
      .updateTable("runs")
      .set({ output_display_seq: "10", output_display_native_seq: String(coverage) })
      .where("id", "=", accepted.runId)
      .execute();
    const views = await readCanonicalPiTurnTranscripts(db, {
      tenantId: owner.tenantId,
      turnIds: [accepted.turnId],
    });
    visible.push({
      coverage,
      tools: views
        .get(accepted.turnId)
        ?.items.filter((item) => item.kind === "tool")
        .map((item) => item.toolName),
    });
  }
  console.log(JSON.stringify({ id: "cold-tool-without-partial-coverage", visible }));

  // Small final tree, substantial intervening Tool history. This measures the
  // actual tree service's reads, not an equivalent hand-written query.
  for (let batch = 0; batch < 8; batch++)
    await appendNativeFixture(
      db,
      activeScope,
      Array.from({ length: 32 }, (_, i) => ({
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: `history-${batch}-${i}`,
            toolName: "bash",
            content: [{ type: "text", text: "x".repeat(4096) }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      })),
    );
  await appendNativeFixture(db, activeScope, [
    {
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ],
    },
  ]);
  await db
    .updateTable("sessions")
    .set({ pi_conversation_id: "1", state: "idle" })
    .where("id", "=", conversation.sessionId)
    .execute();
  await db
    .updateTable("runs")
    .set({ state: "completed", settled_at: new Date() })
    .where("id", "=", accepted.runId)
    .execute();
  await db
    .updateTable("turns")
    .set({ state: "completed", settled_at: new Date() })
    .where("id", "=", accepted.turnId)
    .execute();
  historyReads.length = 0;
  const tree = await new ConversationTreeService({ database: db }).tree(
    owner.tenantId,
    conversation.sessionId,
    "focus",
  );
  console.log(
    JSON.stringify({
      id: "tree-payload-read",
      returnedEntries: tree.branches.reduce((n, b) => n + b.entries.length, 0),
      historyReads,
    }),
  );
  const tenantId = randomUUID(),
    sessionId = randomUUID();
  await db.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  await db
    .insertInto("pi_sessions")
    .values({
      tenant_id: tenantId,
      id: sessionId,
      created_at_ms: Date.now(),
      parent_session_id: null,
      name: null,
    })
    .execute();
  const projection = new DurablePostgresProjection(db, { tenantId, sessionId });
  const costs = [];
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      const before = queries.length;
      await projection.apply(batch);
      costs.push({ writes: batch.writes.length, statements: queries.length - before });
    },
    waitProjected: async () => {},
  });
  await store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "document.create",
        record: {
          id: 2,
          kind: "review.live",
          scope: { kind: "conversation", conversationId: 1 },
          history: "latest",
          fork: "current",
        },
        content: { kind: "base", version: 1, value: { text: "" } },
      },
    ],
    context,
  );
  costs.length = 0;
  for (let index = 1; index <= 10; index++)
    await store.commit(
      [
        {
          type: "document.change",
          id: 2,
          content: { kind: "delta", version: 1, ops: [["s", ["text"], "x".repeat(index * 100)]] },
        },
      ],
      context,
    );
  console.log(
    JSON.stringify({ id: "projection-round-trips", includesBeginCommit: true, samples: costs }),
  );
  await store.close(context);

  // Valid indexed log rows with a deliberately sparse old Conversation. Bulk
  // population avoids benchmarking fixture creation or model/network latency.
  const count = 20000;
  await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count)
    values(${tenantId}::uuid,${sessionId},12,${count + 100},'fixture',${count})`.execute(db);
  await sql`insert into pi_durable_log(tenant_id,session_id,seq,ordinal,record_kind,record_id,body)
    select ${tenantId}::uuid,${sessionId},12,n,'entry',n+100,
      jsonb_build_object('type','entry','value',jsonb_build_object('id',n+100,'conversationId',case when n<=10 then 1 else 3 end,'kind','review.entry','model',jsonb_build_array(jsonb_build_object('role','user','content','fixture','timestamp',1))))::text
    from generate_series(1,${count}) n`.execute(db);
  await sql`insert into pi_durable_records(tenant_id,session_id,id,kind,seq,ordinal,fields)
    select ${tenantId}::uuid,${sessionId},n+100,'entry',12,n,
      jsonb_build_object('conversation',case when n<=10 then '1' else '3' end)
    from generate_series(1,${count}) n`.execute(db);
  await sql`analyze pi_durable_records`.execute(db);
  await sql`analyze pi_durable_log`.execute(db);
  preparedDb = createDatabase({ connectionString: fixture.url, maxConnections: 1 });
  const indexed = new DurablePostgresProjection(preparedDb, { tenantId, sessionId });
  const runScan = () =>
    indexed.scan({ kind: "entry", fields: { conversation: "1" }, descending: true }, 2);
  for (let i = 0; i < 12; i++) await runScan();
  const prepared = (
    await sql`select name,statement,generic_plans,custom_plans from pg_prepared_statements
    where statement like 'select r.kind%' and statement like '%r.fields->>%'`.execute(preparedDb)
  ).rows[0];
  if (!prepared) throw new Error("Native scan did not use a prepared statement");
  const lit = (value) =>
    typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const values = [tenantId, sessionId, "entry", "conversation", "1", 2];
  const explain = async (name, parameters) => {
    const result = await sql
      .raw(
        `explain (analyze,buffers,format json) execute "${name}"(${parameters.map(lit).join(",")})`,
      )
      .execute(preparedDb);
    const plan = result.rows[0]["QUERY PLAN"][0];
    const scans = [];
    const walk = (node) => {
      if (node["Relation Name"])
        scans.push({
          relation: node["Relation Name"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
          removed: node["Rows Removed by Filter"] ?? 0,
          buffers: (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0),
        });
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan.Plan);
    return { milliseconds: plan["Execution Time"], scans };
  };
  const auto = await explain(prepared.name, values);
  await sql`set plan_cache_mode=force_generic_plan`.execute(preparedDb);
  const dynamic = await explain(prepared.name, values);
  const fixed = prepared.statement
    .replace("r.fields->>$4", "r.fields->>'conversation'")
    .replaceAll("$5", "$4")
    .replaceAll("$6", "$5");
  await sql.raw(`prepare review_fixed(uuid,text,text,text,bigint) as ${fixed}`).execute(preparedDb);
  const literalKey = await explain("review_fixed", [tenantId, sessionId, "entry", "1", 2]);
  console.log(
    JSON.stringify({
      id: "native-scan-index-plan",
      rows: count,
      defaultPlanCounts: {
        generic: Number(prepared.generic_plans),
        custom: Number(prepared.custom_plans),
      },
      auto,
      forcedGenericDynamicKey: dynamic,
      forcedGenericLiteralKey: literalKey,
    }),
  );
} finally {
  await preparedDb?.destroy();
  await db.destroy();
  await fixture.close();
}
