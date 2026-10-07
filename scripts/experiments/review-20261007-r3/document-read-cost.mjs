import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { PublishedDurableStorage } from "../../../packages/pi-session-postgres/src/durable/published-storage.ts";
import {
  DurablePostgresProjection,
  materializeNativeDocument,
} from "../../../packages/pi-session-postgres/src/durable/postgres-projection.ts";

const pg = await testPostgres({});
const database = createDatabase({ connectionString: pg.url });
let revisionQueries = 0;
const measured = database.withPlugin({
  transformQuery({ node, queryId }) {
    const sql = database.getExecutor().compileQuery(node, queryId).sql;
    if (sql.includes("pi_durable_document_revisions")) revisionQueries++;
    return node;
  },
  async transformResult({ result }) {
    return result;
  },
});
const stores = [],
  cases = [];
async function time(read, count) {
  const beforeQueries = revisionQueries,
    beforeCpu = process.cpuUsage(),
    before = performance.now();
  let result;
  for (let i = 0; i < count; i++) result = await read();
  const wallMs = performance.now() - before,
    cpu = process.cpuUsage(beforeCpu);
  return {
    result,
    reads: count,
    revisionQueries: revisionQueries - beforeQueries,
    wallMs: +wallMs.toFixed(3),
    processCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(3),
  };
}
try {
  await runMigrations(database, "up");
  for (const deltas of [20, 130, 1024]) {
    const tenantId = randomUUID(),
      sessionId = randomUUID();
    await database.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
    await database
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
    const batches = [];
    const store = await PublishedDurableStorage.open({
      projection,
      publish: async (batch) => {
        batches.push(batch);
      },
      waitProjected: async () => {
        throw Error("Fixture must retain its bounded overlay");
      },
    });
    stores.push(store);
    await store.commit(
      [
        { type: "conversation", value: { id: 1 } },
        {
          type: "document.create",
          record: {
            id: 2,
            kind: "cost",
            scope: { kind: "conversation", conversationId: 1 },
            history: "rewindable",
            fork: "asOf",
          },
          content: { kind: "base", version: 1, value: { count: 0, text: "x".repeat(16384) } },
        },
      ],
      context,
    );
    for (let count = 1; count <= deltas; count++)
      await store.commit(
        [
          {
            type: "document.change",
            id: 2,
            content: { kind: "delta", version: 1, ops: [["s", ["count"], count]] },
          },
        ],
        context,
      );
    const local = await time(() => store.document(2, "current", context), 40);
    assert.equal(local.result.value.count, deltas);
    assert.equal(local.result.deltasSinceBase, deltas);
    assert.equal(local.revisionQueries, 0);
    for (const batch of batches) await projection.apply(batch);
    const cold = await PublishedDurableStorage.open({
      projection,
      publish: async () => {
        throw Error("Read-only fixture");
      },
      waitProjected: async () => {},
    });
    stores.push(cold);
    const indexed = await time(() => cold.document(2, "current", context), 40);
    assert.deepEqual(indexed.result, local.result);
    assert.equal(indexed.revisionQueries, 40);
    const revisions = await projection.revisions(2, store.committedSequence);
    const record = local.result.record;
    const localRevisions = batches.flatMap((batch) =>
      batch.writes.flatMap((write) =>
        "content" in write
          ? [
              {
                id: 2,
                seq: batch.seq,
                ordinal: 0,
                content: write.content,
                deltaCount: batch.seq - 1,
              },
            ]
          : [],
      ),
    );
    const localCpu = await time(() => materializeNativeDocument(record, localRevisions), 200);
    const checkpointCpu = await time(() => materializeNativeDocument(record, revisions), 200);
    for (const measurement of [local, indexed, localCpu, checkpointCpu]) delete measurement.result;
    cases.push({
      deltas,
      baseTextBytes: 16384,
      checkpointTailRevisions: revisions.length,
      acknowledgedLocal: local,
      coldIndexed: indexed,
      materializeLocalSuffix: localCpu,
      materializeDerivedCheckpoint: checkpointCpu,
    });
  }
  const result = {
    scope:
      "owned loopback PG; acknowledged fixture publication; synthetic document, no model or production deployment",
    limitation:
      "Process CPU includes JS/GC scheduling; cold read CPU excludes the separate PG process. Timings are not a capacity guarantee.",
    cases,
  };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-document-read-cost.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  for (const store of stores) await store.close(context);
  await database.destroy();
  await pg.close();
}
