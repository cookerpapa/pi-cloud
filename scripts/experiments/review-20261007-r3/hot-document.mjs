import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { PublishedDurableStorage } from "../../../packages/pi-session-postgres/src/durable/published-storage.ts";
import { DurablePostgresProjection } from "../../../packages/pi-session-postgres/src/durable/postgres-projection.ts";
const pg = await testPostgres({});
const db = createDatabase({ connectionString: pg.url });
let store;
const queries = [];
let rejectQueries = false;
const measured = db.withPlugin({
  transformQuery({ node, queryId }) {
    const query = db.getExecutor().compileQuery(node, queryId).sql;
    queries.push(query);
    if (rejectQueries) throw Error("Owned unavailable projection read");
    return node;
  },
  async transformResult({ result }) {
    return result;
  },
});
try {
  await runMigrations(db, "up");
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
  const projection = new DurablePostgresProjection(measured, { tenantId, sessionId });
  const published = [];
  store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      published.push(batch);
    },
    waitProjected: async () => {
      throw Error("Probe does not evict its overlay");
    },
  });
  await store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "document.create",
        record: {
          id: 2,
          kind: "review",
          scope: { kind: "conversation", conversationId: 1 },
          history: "rewindable",
          fork: "asOf",
        },
        content: { kind: "base", version: 1, value: { counter: 0 } },
      },
    ],
    BACKGROUND_CONTEXT,
  );
  queries.length = 0;
  for (let i = 1; i <= 20; i++) {
    await store.commit(
      [
        {
          type: "document.change",
          id: 2,
          content: { kind: "delta", version: 1, ops: [["s", ["counter"], i]] },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    assert.equal((await store.document(2, "current", BACKGROUND_CONTEXT)).value.counter, i);
  }
  const reads = queries.length;
  assert(queries.every((q) => q.includes("pi_durable_document_revisions")));
  rejectQueries = true;
  let failed = false;
  try {
    await store.document(2, "current", BACKGROUND_CONTEXT);
  } catch {
    failed = true;
  }
  rejectQueries = false;
  const head = await projection.head();
  assert.equal(head.seq, 0);
  const result = {
    scope: "isolated real PostgreSQL; acknowledged publication fixture with PG projection held",
    documentReads: 20,
    unnecessaryRevisionSqlReads: reads,
    projectionHead: head.seq,
    publishedBatches: published.length,
    allValuesCorrect: true,
    completeLocalDocumentFailsWhenProjectionReadFails: failed,
  };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-hot-document.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  rejectQueries = false;
  await store?.close(BACKGROUND_CONTEXT);
  await db.destroy();
  await pg.close();
}
