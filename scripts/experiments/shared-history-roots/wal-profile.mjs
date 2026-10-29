// Independent write-amplification measurement on the same isolated PG instance.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withDatabase, userEntry, append } from "./fixture.mjs";
import { HistoryStore } from "./store.mjs";
import { distribution } from "./benchmark.mjs";

const output = resolve(
  process.argv[2] ??
    "deploy/production/runtime/work-evidence/shared-history-roots-20261029/wal.json",
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const report = {
  at: new Date().toISOString(),
  completed: false,
  productionReady: false,
  scope:
    "Synthetic append WAL and heap tuple sizes; no Kafka, production state machine or per-Fork materialization",
  cases: [],
};
try {
  await withDatabase(async ({ pool }) => {
    for (const textBytes of [768, 30720]) {
      const tenant = randomUUID(),
        modes = [
          { name: "flat", store: new HistoryStore(pool, { directory: false }) },
          { name: "shared", store: new HistoryStore(pool) },
        ];
      for (const m of modes) {
        m.view = await m.store.create(tenant);
        m.wal = [];
      }
      for (let i = 0; i < 240; i++) {
        const fragment = randomBytes(256).toString("hex");
        const entries = [0, 1].map((n) =>
          userEntry(
            modes[0].view.next_id + n,
            fragment.repeat(Math.ceil(textBytes / fragment.length)).slice(0, textBytes),
          ),
        );
        for (const m of i % 2 ? [...modes].reverse() : modes) {
          const start = (await pool.query("select pg_current_wal_insert_lsn() as lsn")).rows[0].lsn;
          await append(m.store, m.view, entries);
          const bytes = Number(
            (
              await pool.query(
                "select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn) as bytes",
                [start],
              )
            ).rows[0].bytes,
          );
          if (i >= 40) m.wal.push(bytes);
        }
      }
      const values = {};
      for (const m of modes) {
        const row = (
          await pool.query(
            `select count(*)::int records,sum(pg_column_size(e))::text tuple_bytes,
          sum(body_bytes)::text logical_body_bytes from lab_entries e where stream=(select stream from lab_views where id=$1)`,
            [m.view.id],
          )
        ).rows[0];
        values[m.name] = {
          wal: distribution(m.wal),
          totalWalBytes: m.wal.reduce((a, b) => a + b, 0),
          records: row.records,
          heapTupleBytes: Number(row.tuple_bytes),
          logicalBodyBytes: Number(row.logical_body_bytes),
        };
      }
      assert.equal(values.flat.records, values.shared.records);
      assert.equal(values.flat.logicalBodyBytes, values.shared.logicalBodyBytes);
      report.cases.push({
        textBytes,
        ...values,
        walRatio: values.shared.totalWalBytes / values.flat.totalWalBytes,
        tupleRatio: values.shared.heapTupleBytes / values.flat.heapTupleBytes,
      });
    }
  });
  report.completed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
