import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withDatabase, userEntry, append, drain } from "./fixture.mjs";
import { HistoryStore } from "./store.mjs";
import { openNativeReader } from "./native-reader.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b),
    at = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}
async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { milliseconds: performance.now() - start, value };
}
function payload(id, size) {
  const seed = randomBytes(Math.min(256, Math.ceil(size / 2))).toString("hex");
  return userEntry(
    id,
    (`entry ${id} ` + seed).repeat(Math.ceil(size / seed.length)).slice(0, size),
  );
}
async function trace(store, fn) {
  const result = {
    queries: 0,
    parameterBytes: 0,
    resultBytes: 0,
    bodyRows: 0,
    bodyBytes: 0,
    newNodes: 0,
    newEntries: 0,
  };
  const previous = store.observe;
  store.observe = (e) => {
    result.queries++;
    result.parameterBytes += Buffer.byteLength(JSON.stringify(e.values));
    result.resultBytes += Buffer.byteLength(JSON.stringify(e.rows));
    for (const row of e.rows)
      if (Object.hasOwn(row, "body")) {
        result.bodyRows++;
        result.bodyBytes += Buffer.byteLength(row.body);
      }
    if (/^insert into lab_nodes/i.test(e.text)) result.newNodes += e.rowCount;
    if (/^insert into lab_entries/i.test(e.text)) result.newEntries += e.rowCount;
  };
  try {
    const measured = await timed(fn);
    return { ...result, milliseconds: measured.milliseconds, value: measured.value };
  } finally {
    store.observe = previous;
  }
}
async function activeSuffix(store, view) {
  const first = view.next_id,
    entries = [];
  for (let i = 0; i < 16; i++) entries.push(payload(first + i, 1024));
  entries.push({
    ...userEntry(first + 16, "Synthetic summary of older history"),
    kind: "pi.compaction",
    head: first,
  });
  for (let i = 17; i < 25; i++) entries.push(payload(first + i, 1024));
  await append(store, view, entries);
  return { head: first + 16, first, tail: view.next_id - 1 };
}
async function contextRead(store, view) {
  const reader = await openNativeReader(store, view.tenant, view.id);
  try {
    return await reader.context();
  } finally {
    await reader.close();
  }
}
function ratio(after, before) {
  return after.p95 / before.p95;
}

async function ordinary(pool, size, samples) {
  const tenant = randomUUID();
  const modes = [
    { name: "flat", store: new HistoryStore(pool, { directory: false }) },
    { name: "shared", store: new HistoryStore(pool) },
  ];
  for (const m of modes) {
    m.view = await m.store.create(tenant);
    m.append = [];
    m.read = [];
    m.context = [];
  }
  // Identical bodies, IDs, transaction sizes, indexes and integrity policy. The
  // only difference is prefix bookkeeping. Timings exclude measurement encoding.
  for (let batch = 0; batch < 8; batch++) {
    const entries = Array.from({ length: 16 }, (_, i) => payload(modes[0].view.next_id + i, size));
    for (const m of modes) await append(m.store, m.view, entries);
  }
  for (let iteration = 0; iteration < samples + 20; iteration++) {
    const entries = Array.from({ length: 2 }, (_, i) => payload(modes[0].view.next_id + i, size));
    for (const m of iteration % 2 ? [...modes].reverse() : modes) {
      const a = await timed(() => append(m.store, m.view, entries));
      const r = await timed(() => m.store.page(tenant, m.view.id, { limit: 16 }));
      assert.equal(r.value.items.length, 16);
      if (iteration >= 20) {
        m.append.push(a.milliseconds);
        m.read.push(r.milliseconds);
      }
    }
  }
  for (const m of modes) await activeSuffix(m.store, m.view);
  for (let iteration = 0; iteration < 40; iteration++)
    for (const m of iteration % 2 ? [...modes].reverse() : modes) {
      const c = await timed(() => contextRead(m.store, m.view));
      assert.equal(c.value.entries.length, 25);
      if (iteration >= 10) m.context.push(c.milliseconds);
    }
  const result = Object.fromEntries(
    modes.map((m) => [
      m.name,
      {
        append: distribution(m.append),
        page: distribution(m.read),
        context: distribution(m.context),
      },
    ]),
  );
  result.p95Ratios = {
    append: ratio(result.shared.append, result.flat.append),
    page: ratio(result.shared.page, result.flat.page),
    context: ratio(result.shared.context, result.flat.context),
  };
  result.withinTenPercent = Object.values(result.p95Ratios).every((r) => r <= 1.1);
  result.entryTextBytes = size;
  for (const m of modes) await m.store.remove(tenant, m.view.id);
  await drain(modes[1].store, tenant, 256);
  return result;
}

export async function benchmark(directory) {
  const report = {
    at: new Date().toISOString(),
    completed: false,
    productionReady: false,
    scope:
      "Isolated history directory; native read-only context, no full mutable Storage/Kafka/S3/UI implementation",
    cachePolicy:
      "Fresh native reader for context; PostgreSQL/OS caches are not forcibly flushed. Timed samples exclude trace serialization.",
    sizes: [],
    ordinary: [],
    nested: undefined,
    gc: undefined,
  };
  const sizes = (process.env.PI_CLOUD_ROOT_BENCH_MIB ?? "10,100,1024").split(",").map(Number);
  const nested = Number(process.env.PI_CLOUD_ROOT_BENCH_NESTED ?? 1000),
    samples = Number(process.env.PI_CLOUD_ROOT_BENCH_SAMPLES ?? 120);
  assert(sizes.every((v, i) => Number.isFinite(v) && v > 0 && (i === 0 || v > sizes[i - 1])));
  assert(
    Number.isSafeInteger(nested) && nested >= 32 && Number.isSafeInteger(samples) && samples >= 30,
  );
  const phase = (name) =>
    console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
  const save = () =>
    writeFile(resolve(directory, "benchmark.json"), JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  await withDatabase(async ({ pool }) => {
    const store = new HistoryStore(pool),
      tenant = randomUUID(),
      source = await store.create(tenant);
    let totalBytes = 0,
      totalEntries = 0;
    for (const mib of sizes) {
      phase(`seed ${mib} MiB`);
      while (totalBytes < mib * 1024 ** 2) {
        const entries = Array.from({ length: 32 }, (_, i) =>
          payload(source.next_id + i, 30 * 1024),
        );
        totalBytes += entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
        totalEntries += entries.length;
        await append(store, source, entries);
      }
      const suffix = await activeSuffix(store, source);
      totalEntries += 25;
      await pool.query("analyze lab_entries; analyze lab_views; analyze lab_nodes");
      phase(`measure ${mib} MiB Fork and first native context`);
      const measured = await trace(store, () =>
        store.fork(tenant, source.id, suffix.tail, `trace-${mib}`),
      );
      const fork = measured.value;
      delete measured.value;
      assert.equal(measured.bodyRows, 0);
      assert.equal(measured.newEntries, 0);
      assert(measured.newNodes <= 2);
      const first = await trace(store, () => contextRead(store, fork));
      assert.equal(first.value.head.id, suffix.head);
      assert.equal(first.value.entries.length, 25);
      assert(first.bodyRows <= 32 && first.bodyBytes < 128 * 1024);
      delete first.value;
      const forks = [],
        pages = [],
        contexts = [],
        directPages = [],
        directContexts = [];
      // A read-only direct index over the identical immutable source rows. The
      // source is not appended during this paired read comparison; no writer is
      // created and this is not a product Fork implementation.
      const direct = { id: randomUUID(), tenant };
      await pool.query(
        `insert into lab_views(id,tenant,stream,seq,next_id,read_only)
        select $1,tenant,stream,seq,next_id,true from lab_views where id=$2`,
        [direct.id, source.id],
      );
      const flatReader = new HistoryStore(pool, { directory: false });
      for (let i = 0; i < 30; i++) {
        const result = await timed(() =>
          store.fork(tenant, source.id, suffix.tail, `sample-${mib}-${i}`),
        );
        forks.push(result.milliseconds);
        await store.remove(tenant, result.value.id);
        const readers = [
          { s: store, v: fork, pages, contexts },
          { s: flatReader, v: direct, pages: directPages, contexts: directContexts },
        ];
        for (const r of i % 2 ? readers.reverse() : readers) {
          r.pages.push((await timed(() => r.s.page(tenant, r.v.id, { limit: 16 }))).milliseconds);
          const c = await timed(() => contextRead(r.s, r.v));
          assert.equal(c.value.entries.length, 25);
          r.contexts.push(c.milliseconds);
        }
      }
      const count = (
        await pool.query(
          "select count(*)::int n from lab_entries e join lab_streams s on s.id=e.stream where s.tenant=$1",
          [tenant],
        )
      ).rows[0].n;
      assert.equal(count, totalEntries);
      report.sizes.push({
        mib,
        seededBodyBytes: totalBytes,
        entries: totalEntries,
        forkTrace: measured,
        firstNativeContextTrace: first,
        fork: distribution(forks),
        page: distribution(pages),
        context: distribution(contexts),
        directIndexPage: distribution(directPages),
        directIndexContext: distribution(directContexts),
        inheritedReadP95Ratios: {
          page: ratio(distribution(pages), distribution(directPages)),
          context: ratio(distribution(contexts), distribution(directContexts)),
        },
      });
      await save();
      await flatReader.remove(tenant, direct.id);
      await store.remove(tenant, fork.id);
      await drain(store, tenant, 256);
    }
    phase(`measure ${nested} nested Forks`);
    const branchTenant = randomUUID();
    let view = await store.create(branchTenant);
    const times = [];
    for (let i = 0; i < nested; i++) {
      const id = view.next_id;
      await append(store, view, [payload(id, 1024)]);
      const result = await timed(() => store.fork(branchTenant, view.id, id, "nested-" + i));
      times.push(result.milliseconds);
      await store.remove(branchTenant, view.id);
      view = result.value;
    }
    await pool.query("analyze lab_nodes; analyze lab_entries");
    const depth = (
      await pool.query(
        `select n.height from lab_views v join lab_nodes n on n.id=v.base where v.id=$1`,
        [view.id],
      )
    ).rows[0].height;
    assert(depth <= 2 * Math.ceil(Math.log2(nested)) + 1);
    const pageTrace = await trace(store, () => store.page(branchTenant, view.id, { limit: 32 }));
    assert.equal(pageTrace.value.items.length, 32);
    delete pageTrace.value;
    const readSamples = [],
      directSamples = [];
    const exact = [],
      nativeEntries = [];
    let cursor;
    do {
      const page = await store.page(branchTenant, view.id, { limit: 32, cursor });
      exact.push(...page.items.map((r) => r.entry.id));
      nativeEntries.push(...page.items.map((r) => r.entry));
      cursor = page.next;
    } while (cursor);
    assert.equal(exact.length, nested);
    assert.equal(new Set(exact).size, nested);
    // The small nested-history fixture is materialized once solely to compare
    // its direct read path. This setup is measured separately, never hidden in
    // a Fork or first-context timing.
    const flatReader = new HistoryStore(pool, { directory: false }),
      flatView = await flatReader.create(branchTenant);
    nativeEntries.reverse();
    const materializeStart = performance.now();
    for (let i = 0; i < nativeEntries.length; i += 32)
      await append(flatReader, flatView, nativeEntries.slice(i, i + 32));
    const materializationMs = performance.now() - materializeStart;
    await pool.query("update lab_views set read_only=true where id=$1", [flatView.id]);
    for (let i = 0; i < 40; i++) {
      const readers = [
        { s: store, v: view, times: readSamples },
        { s: flatReader, v: flatView, times: directSamples },
      ];
      for (const r of i % 2 ? readers.reverse() : readers)
        r.times.push(
          (await timed(() => r.s.page(branchTenant, r.v.id, { limit: 32 }))).milliseconds,
        );
    }
    const deleted = await drain(store, branchTenant, 256);
    report.nested = {
      forks: nested,
      height: depth,
      early: distribution(times.slice(0, Math.min(50, nested))),
      late: distribution(times.slice(-Math.min(50, nested))),
      pageTrace,
      page: distribution(readSamples),
      directIndexPage: distribution(directSamples),
      directIndexSetupMs: materializationMs,
      readP95Ratio: ratio(distribution(readSamples), distribution(directSamples)),
      allIdsRetained: true,
      orphanDirectoryCollection: deleted,
    };
    await save();

    phase("interleaved flat/shared ordinary append and page comparison");
    for (const size of [768, 30 * 1024]) {
      report.ordinary.push(await ordinary(pool, size, samples));
      await save();
    }

    phase("bounded aggressive GC interference");
    const gcTenant = randomUUID(),
      live = await store.create(gcTenant);
    await append(
      store,
      live,
      Array.from({ length: 32 }, (_, i) => payload(2 + i, 4096)),
    );
    const measureLive = async () => {
      const a = [],
        r = [];
      for (let i = 0; i < samples; i++) {
        a.push(
          (await timed(() => append(store, live, [payload(live.next_id, 4096)]))).milliseconds,
        );
        r.push((await timed(() => store.page(gcTenant, live.id, { limit: 16 }))).milliseconds);
      }
      return { append: distribution(a), page: distribution(r) };
    };
    const without = await measureLive();
    for (let i = 0; i < 64; i++) {
      const garbage = await store.create(gcTenant);
      await append(
        store,
        garbage,
        Array.from({ length: 64 }, (_, j) => payload(j + 2, 4096)),
      );
      await store.remove(gcTenant, garbage.id);
    }
    let stop = false,
      ticks = 0,
      collected = 0,
      gcError;
    const collector = new HistoryStore(pool);
    const background = (async () => {
      try {
        while (!stop) {
          const r = await collector.collect(gcTenant, 64);
          ticks++;
          collected += r.records;
          await sleep(10);
        }
      } catch (error) {
        gcError = error;
      }
    })();
    let withGc;
    try {
      withGc = await measureLive();
    } finally {
      stop = true;
      await background;
    }
    if (gcError) throw gcError;
    report.gc = {
      intervalMs: 10,
      batch: 64,
      without,
      withGc,
      ticks,
      collected,
      p95Ratios: {
        append: ratio(withGc.append, without.append),
        page: ratio(withGc.page, without.page),
      },
    };
    await drain(store, gcTenant, 256);
    report.gates = {
      noBodyCopy: report.sizes.every(
        (r) => r.forkTrace.bodyRows === 0 && r.forkTrace.newEntries === 0,
      ),
      subsecondDirectoryFork: report.sizes.every((r) => r.fork.p95 < 1000),
      boundedFirstContext: report.sizes.every((r) => r.firstNativeContextTrace.bodyRows <= 32),
      ordinaryWithinTenPercent: report.ordinary.every((r) => r.withinTenPercent),
      inheritedReadWithinTenPercent:
        report.sizes.every((r) => Object.values(r.inheritedReadP95Ratios).every((v) => v <= 1.1)) &&
        report.nested.readP95Ratio <= 1.1,
      fullNativeStorage: false,
      productionMigration: false,
    };
    report.completed = true;
    await save();
  });
  return report;
}
