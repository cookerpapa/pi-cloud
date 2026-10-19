// Review only: owned disposable PostgreSQL, in-memory object bytes and native public ports.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { Client } from "pg";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "../../../packages/pi-session-postgres/src/durable/index.ts";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import {
  ImageAttachmentCodec,
  PostgresImageAttachmentStore,
} from "../../../packages/session-attachments/src/index.ts";

const output = resolve(process.argv[2] ?? "dist/reviews/worker-harness-recovery-20261019.json");
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  piVersion: "1.0.0",
  scope: "Owned disposable PG and native public interfaces; no production/Kafka/VM/provider access",
  cases: [],
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let pg, db;
async function fixture(images) {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await db.insertInto("tenants").values({ id: scope.tenantId, slug: scope.tenantId }).execute();
  await db
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(db, scope, images);
  const options = {
    projection,
    publish: async (batch) =>
      projection.apply(images ? await images.pack(scope, batch) : batch, [], {
        topic: "owned-review",
        partition: 0,
        offset: BigInt(batch.seq),
      }),
    waitProjected: async () => {},
  };
  const store = await PublishedDurableStorage.open(options);
  return { scope, projection, store, options };
}
function observed(promise) {
  const state = { settled: false, outcome: "pending" };
  const done = promise.then(
    (value) => {
      state.settled = true;
      state.outcome = "resolved";
      return value;
    },
    (error) => {
      state.settled = true;
      state.outcome = "rejected";
      state.error = error;
      throw error;
    },
  );
  void done.catch(() => {});
  return { state, done };
}
async function acquisition() {
  const pool = createDatabase({ connectionString: pg.url, maxConnections: 1 });
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const holder = pool.connection().execute(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const opening = observed(
    PublishedDurableStorage.open({
      projection: new DurablePostgresProjection(pool, {
        tenantId: randomUUID(),
        sessionId: randomUUID(),
      }),
      publish: async () => {},
      waitProjected: async () => {},
    }),
  );
  try {
    const start = performance.now();
    await pause(250);
    assert.equal(opening.state.settled, false);
    report.cases.push({
      name: "cold_open_pool_acquisition",
      observedWaitMs: performance.now() - start,
      settledBeforeConnectionReleased: false,
    });
  } finally {
    release.resolve();
    await holder;
    await (await opening.done).close(context);
    await pool.destroy();
  }
}
async function cancelledRead() {
  const f = await fixture();
  await f.store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "entry",
        value: { id: 2, conversationId: 1, kind: "review.entry", data: "retained" },
      },
    ],
    context,
  );
  await f.store.close(context);
  const cold = await PublishedDurableStorage.open(f.options),
    locker = new Client({ connectionString: pg.url });
  const abort = new AbortController();
  let read, closing;
  await locker.connect();
  await locker.query("begin");
  await locker.query("lock table pi_durable_records in access exclusive mode");
  try {
    read = observed(cold.entry(2, withAbortSignal(abort.signal, context)));
    const until = Date.now() + 2000;
    for (;;) {
      const { rows } =
        await sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pi_durable_records%'`.execute(
          db,
        );
      if (rows[0].n) break;
      assert(Date.now() < until);
      await pause(10);
    }
    abort.abort(new Error("owned read cancelled"));
    closing = observed(cold.close(context));
    const start = performance.now();
    await pause(250);
    assert(!read.state.settled && !closing.state.settled);
    report.cases.push({
      name: "cancelled_cold_read",
      observedAfterAbortMs: performance.now() - start,
      readSettled: false,
      storageCloseSettled: false,
    });
  } finally {
    await locker.query("rollback");
    await locker.end();
    if (read) {
      const value = await read.done;
      assert.equal(value.entry.data, "retained");
      report.cases.at(-1).resolvedDespiteCancelledContext = true;
    }
    await closing?.done;
    await cold.close(context);
  }
}
async function imageReads() {
  const objects = new Map();
  let reads = 0,
    hold,
    entered,
    blobSignal;
  const store = new PostgresImageAttachmentStore(db, {
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async *readStream(key, _maximum, signal) {
      reads++;
      blobSignal = signal;
      if (hold) {
        entered.resolve();
        await hold.promise;
      }
      yield objects.get(key);
    },
    async delete(key) {
      objects.delete(key);
    },
  });
  const codec = new ImageAttachmentCodec(store),
    f = await fixture(codec);
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII=";
  const image = { type: "image", mimeType: "image/png", data };
  await f.store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "entry",
        value: {
          id: 2,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: [image], timestamp: 0 }],
        },
      },
    ],
    context,
  );
  await f.store.close(context);
  const cold = await PublishedDurableStorage.open(f.options);
  hold = Promise.withResolvers();
  entered = Promise.withResolvers();
  const abort = new AbortController();
  const read = observed(cold.entry(2, withAbortSignal(abort.signal, context)));
  try {
    await entered.promise;
    abort.abort(new Error("owned image read cancelled"));
    await pause(100);
    assert.equal(blobSignal.aborted, false);
    assert.equal(read.state.settled, false);
    report.cases.push({
      name: "cancelled_native_image_read",
      callerAborted: true,
      blobSignalAborted: blobSignal.aborted,
      readSettled: read.state.settled,
      storeHasOwn60sDeadline: true,
    });
  } finally {
    hold.resolve();
    await read.done;
    hold = undefined;
    await cold.close(context);
  }
  const fresh = await PublishedDurableStorage.open(f.options);
  const harness = await Harness.open(
    fresh,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.conversation(1, context);
    reads = 0;
    const active = await root.context(context);
    assert.equal(active.messages[0].content[0].data, data);
    report.cases.push({
      name: "one_image_context_reads",
      blobReads: reads,
      uniqueImages: 1,
      nativeEntries: active.entries.length,
    });
  } finally {
    await harness.close(context);
  }
}

try {
  report.probeSha256 = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  pg = await testPostgres({});
  db = createDatabase({ connectionString: pg.url, maxConnections: 4 });
  await runMigrations(db, "up");
  await acquisition();
  await cancelledRead();
  await imageReads();
  report.completed = true;
} finally {
  await db?.destroy();
  await pg?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
