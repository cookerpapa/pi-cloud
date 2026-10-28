// Isolated PG + actual API/SSE + actual Web. No model, producer or sandbox claims.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Pool } from "pg";
import { sql } from "kysely";
import { preview } from "vite";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import {
  createControlPlaneApplication,
  createPrivateTenant,
  ControlPlaneStore,
} from "../packages/control-plane/src/index.ts";
import { DurablePostgresProjection } from "../packages/pi-session-postgres/src/durable/index.ts";
import { ConversationTreeService } from "../packages/control-plane/src/conversation-tree-service.ts";
import { reapUnreferencedEntryBodies } from "../packages/pi-session-postgres/src/durable/index.ts";
import { SessionLiveView } from "../packages/runtime-core/src/session-live-view.ts";
import {
  createPiCloudEventFactory,
  HISTORY_BROWSER_PAGES,
} from "../packages/protocol/src/index.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert(
  process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL,
  "Run through scripts/run-with-test-postgres.mjs",
);
const target = Number(process.env.PI_CLOUD_HISTORY_CHECK_BYTES ?? 1024 ** 3);
assert(Number.isSafeInteger(target) && target >= 8 * 1024 ** 2);
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/history-window-check",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { at: new Date().toISOString(), accepted: false, targetBytes: target, phases: [] };
const save = () =>
  writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const phase = (name) => {
  console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
  report.phases.push(name);
};
const admin = new Pool({ connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, max: 1 });
const databaseName = "history_check_" + randomUUID().replaceAll("-", "");
await admin.query(`create database "${databaseName}"`);
const endpoint = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL);
endpoint.pathname = "/" + databaseName;
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 6 });
let app, vite, cache, failure, readDb;
const live = new SessionLiveView(async () => {});
try {
  execFileSync("npm", ["run", "build", "--workspace", "@pi-cloud/web-ui"], { stdio: "inherit" });
  cache = await mkdtemp(join(tmpdir(), "pi-cloud-history-web-"));
  await cp(resolve("packages/web-ui/dist"), join(cache, "dist"), { recursive: true });
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "history-check-" + randomUUID(),
    ownerDisplayName: "History acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({
    name: "History window fixture",
    source: { kind: "empty" },
  });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Large history fixture",
    "elastic",
  );
  const run = await store.acceptTurn(session.sessionId, randomUUID(), {
    prompt: "Synthetic history, no execution requested.",
  });
  const binding = await db
    .selectFrom("sessions")
    .select("pi_session_id")
    .where("id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  const projection = new DurablePostgresProjection(db, {
    tenantId: tenant.tenantId,
    sessionId: binding.pi_session_id,
  });
  let lastToolId = 0;
  let seq = 0,
    nextId = 2,
    logical = 0,
    units = 0;
  const publish = async (writes, scope = run) => {
    const bytes = writes.reduce((n, w) => n + Buffer.byteLength(JSON.stringify(w)), 0);
    logical += bytes;
    await projection.apply(
      { seq: ++seq, nextId, writes },
      writes.map((w) => ({
        recordId: w.value.id,
        sessionId: session.sessionId,
        runId: scope.runId,
        turnId: scope.turnId,
      })),
      { topic: "history-acceptance-fixture", partition: 0, offset: BigInt(seq) },
    );
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (id, text, stopReason = "stop", extra = []) => ({
    type: "entry",
    value: {
      id,
      conversationId: 1,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-6-luna",
          content: [{ type: "text", text }, ...extra],
          timestamp: Date.now(),
          stopReason,
          usage,
        },
      ],
    },
  });
  await publish([{ type: "conversation", value: { id: 1 } }]);
  phase("seed real native history and query indexes");
  const started = performance.now();
  const targets = [];
  while (logical < target) {
    const writes = [];
    for (let batch = 0; batch < 16; batch++) {
      const n = units++,
        a = nextId++,
        task = nextId++,
        result = nextId++;
      const paragraph =
        `History message ${n}. This is generated acceptance data. ` +
        randomBytes(256).toString("hex");
      const text = `### History marker ${n}\n\n` + (paragraph + "\n\n").repeat(28);
      writes.push(
        assistant(a, text, "toolUse", [
          {
            type: "toolCall",
            id: "reused-call",
            name: "read",
            arguments: { path: `fixture-${n}.txt` },
          },
        ]),
      );
      lastToolId = task;
      writes.push({
        type: "task",
        value: {
          id: task,
          conversationId: 1,
          kind: "pi.tool",
          version: 1,
          input: { assistant: a, callId: "reused-call" },
          background: false,
          abortRequested: false,
          state: {
            status: "terminal",
            outcome: { status: "completed", result: { entryId: result } },
          },
        },
      });
      writes.push({
        type: "entry",
        value: {
          id: result,
          conversationId: 1,
          byTaskId: task,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolName: "read",
              toolCallId: "reused-call",
              content: [
                { type: "text", text: ("Result " + n + " " + paragraph + "\n").repeat(82) },
              ],
              isError: false,
              timestamp: Date.now(),
            },
          ],
        },
      });
      if (n % 64 === 0) {
        const final = nextId++;
        writes.push(assistant(final, `Checkpoint ${n}`));
        targets.push({ entryId: String(a), marker: n });
      }
    }
    await publish(writes);
    if (units % 2048 === 0) console.log(JSON.stringify({ seededBytes: logical, units }));
  }
  const final = nextId++;
  await publish([assistant(final, "HISTORY_FIXTURE_END")]);
  await db
    .updateTable("runs")
    .set({
      state: "completed",
      started_at: new Date(),
      settled_at: new Date(),
      output_display_seq: String(seq + 1),
      output_display_native_seq: String(seq),
    })
    .where("id", "=", run.runId)
    .execute();
  await db
    .updateTable("sessions")
    .set({ state: "idle", next_event_seq: String(seq + 2) })
    .where("id", "=", session.sessionId)
    .execute();
  await sql`analyze pi_durable_writes; analyze pi_history_bodies; analyze pi_durable_records; analyze pi_durable_commits`.execute(
    db,
  );
  report.seed = {
    logicalBytes: logical,
    units,
    records: nextId - 1,
    elapsedMs: Math.round(performance.now() - started),
  };
  await save();

  let pointQuery;
  const pointDb = db.withPlugin({
    transformQuery({ node, queryId }) {
      const query = db.getExecutor().compileQuery(node, queryId);
      if (query.sql.includes("pi_durable_record_bodies")) pointQuery = query;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const pointAt = performance.now();
  await new DurablePostgresProjection(
    pointDb,
    { tenantId: tenant.tenantId, sessionId: binding.pi_session_id },
    undefined,
    "references",
  ).get(final);
  const pointMs = performance.now() - pointAt;
  const pointPlan = await db.executeQuery({
    ...pointQuery,
    sql: "explain (analyze,format json) " + pointQuery.sql,
  });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(pointPlan.rows[0]["QUERY PLAN"][0].Plan);
  const bodyReads = nodes.filter((n) => n["Relation Name"] === "pi_history_bodies");
  assert(
    bodyReads.length > 0 && bodyReads.every((n) => n["Actual Rows"] <= 1 && n["Actual Loops"] <= 1),
    "Point read scanned shared history bodies",
  );
  report.pointRead = {
    milliseconds: pointMs,
    bodyRows: bodyReads.map((n) => n["Actual Rows"]),
    bodyIndexes: bodyReads.map((n) => n["Index Name"]),
  };
  let queryCount = 0,
    bodyBytes = 0;
  const measured = db.withPlugin({
    transformQuery({ node }) {
      queryCount++;
      return node;
    },
    async transformResult({ result }) {
      for (const row of result.rows)
        if (typeof row.body === "string") bodyBytes += Buffer.byteLength(row.body);
      return result;
    },
  });
  const measuredStore = new ControlPlaneStore({ database: measured, ...tenant });
  const at = performance.now();
  const latest = await measuredStore.getConversation(session.sessionId);
  report.latestRead = {
    milliseconds: performance.now() - at,
    sql: queryCount,
    bodyBytes,
    responseBytes: Buffer.byteLength(JSON.stringify(latest)),
  };
  assert(latest.history.hasBefore);
  assert(bodyBytes < 12 * 1024 ** 2);
  assert(queryCount < 40);
  const targetEntry = targets[Math.floor(targets.length / 3)];
  queryCount = 0;
  bodyBytes = 0;
  const jumpAt = performance.now();
  await measuredStore.getConversation(session.sessionId, {
    turnId: run.turnId,
    entryId: targetEntry.entryId,
  });
  report.directRead = { milliseconds: performance.now() - jumpAt, sql: queryCount, bodyBytes };
  assert(queryCount < 40);
  assert(bodyBytes < 12 * 1024 ** 2);
  phase("serve actual API, SSE and Web");
  readDb = createDatabase({
    connectionString: endpoint.toString(),
    maxConnections: 4,
    readTimeoutMs: 5000,
  }).withPlugin({
    transformQuery({ node }) {
      queryCount++;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  app = await createControlPlaneApplication({
    database: measured,
    conversationReadDatabase: readDb,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
    eventRuntime: { eventHub: live.eventHub, eventStore: live },
  });
  await app.listen(0, "127.0.0.1");
  const apiUrl = await app.getUrl();
  phase("cancel blocked reads and stream export");
  const blocker = new Pool({ connectionString: endpoint.toString(), max: 1 });
  try {
    await blocker.query("begin");
    await blocker.query("lock table pi_durable_log in access exclusive mode");
    const abort = new AbortController();
    const pending = fetch(`${apiUrl}/v1/conversations/${session.sessionId}`, {
      signal: abort.signal,
    }).catch((error) => error);
    const waitingUntil = Date.now() + 10000;
    for (;;) {
      await blocker.query("select pg_stat_clear_snapshot()");
      const pendingQuery = await blocker.query(
        "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()",
      );
      if (pendingQuery.rows[0].count) break;
      assert(Date.now() < waitingUntil, "HTTP history read did not reach PG");
      await new Promise((r) => setTimeout(r, 25));
    }
    const cancelledAt = performance.now();
    abort.abort();
    await pending;
    const cancelledUntil = Date.now() + 10000;
    for (;;) {
      await blocker.query("select pg_stat_clear_snapshot()");
      const pendingQuery = await blocker.query(
        "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()",
      );
      if (!pendingQuery.rows[0].count) break;
      assert(Date.now() < cancelledUntil, "Cancelled HTTP history read kept its PG query");
      await new Promise((r) => setTimeout(r, 25));
    }
    report.cancelledReadMs = performance.now() - cancelledAt;
    assert(report.cancelledReadMs < 2500, "Read only stopped at its SQL timeout");
  } finally {
    await blocker.query("rollback");
    await blocker.end();
  }
  const interrupted = new AbortController();
  const download = await fetch(`${apiUrl}/v1/conversations/${session.sessionId}/export`, {
    signal: interrupted.signal,
  });
  assert(download.ok);
  assert(download.headers.get("content-disposition")?.includes("attachment"));
  const firstChunk = await download.body.getReader().read();
  assert(firstChunk.value.length > 0);
  interrupted.abort();
  await new Promise((r) => setTimeout(r, 500));
  const stoppedQueries = queryCount;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(queryCount, stoppedQueries, "Aborted export continued reading pages");
  report.cancelledExport = true;
  const exportStarted = performance.now();
  let exportBytes = 0,
    markers = 0,
    toolResults = 0,
    ended = false,
    carry = "";
  const exported = await fetch(`${apiUrl}/v1/conversations/${session.sessionId}/export`);
  assert(exported.ok);
  const decoder = new TextDecoder();
  for await (const bytes of exported.body) {
    exportBytes += bytes.byteLength;
    const lines = (carry + decoder.decode(bytes, { stream: true })).split("\n");
    carry = lines.pop();
    for (const line of lines) {
      if (/^### History marker [0-9]+$/.test(line)) markers++;
      if (line === "<summary>Tool · read · completed</summary>") toolResults++;
      if (line === "HISTORY_FIXTURE_END") ended = true;
    }
  }
  assert(ended);
  assert.equal(markers, units);
  assert.equal(toolResults, units);
  report.export = {
    bytes: exportBytes,
    markers,
    toolResults,
    milliseconds: performance.now() - exportStarted,
  };

  vite = await preview({
    configFile: false,
    root: cache,
    preview: { host: "127.0.0.1", port: 0, proxy: { "/v1": { target: apiUrl } } },
    plugins: [
      {
        name: "history-acceptance-config",
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/ui-config.json") {
              const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
              res.setHeader("content-type", "application/json");
              return res.end(
                JSON.stringify({
                  productUrl: origin,
                  adminUrl: origin,
                  managementUrls: {
                    providerGateway: "",
                    grafana: "",
                    prometheus: "",
                    alertmanager: "",
                    jaeger: "",
                  },
                }),
              );
            }
            // This API-only fixture has no machine controller; its optional resource list is empty.
            if (req.url === "/v1/development-environments") {
              res.setHeader("content-type", "application/json");
              return res.end(JSON.stringify({ environments: [] }));
            }
            next();
          });
        },
      },
    ],
  });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await withChromePage(
    { profilePrefix: "pi-cloud-history-", width: 1280, height: 900 },
    async (page) => {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          "window.historyErrors=[];addEventListener('error',e=>historyErrors.push(String(e.message)));addEventListener('unhandledrejection',e=>historyErrors.push(String(e.reason)));localStorage.setItem('pi-cloud:ui-language','en-US');",
      });
      const readCounts = { history: 0 };
      page.onRequest((url) => {
        if (new URL(url).pathname === `/v1/conversations/${session.sessionId}`)
          readCounts.history++;
      });
      await page.navigate(`${origin}/?session=${session.sessionId}`);
      try {
        await page.waitFor(
          "document.querySelector('.product-topbar-title strong')?.textContent==='Large history fixture'",
          60000,
        );
        await page.waitFor("document.querySelector('[data-history-row-key]')", 60000);
        await page.send("Runtime.enable");
        await page.send("Performance.enable");
        const memory = async () => {
          await page.send("HeapProfiler.collectGarbage");
          return (await page.send("Performance.getMetrics")).metrics.find(
            (m) => m.name === "JSHeapUsedSize",
          ).value;
        };
        const view = () =>
          page.evaluate(
            `(()=>{const p=document.querySelector('.product-chat-scroll');const top=p.getBoundingClientRect().top;const n=[...p.querySelectorAll('[data-history-row-key]')].find(n=>n.getBoundingClientRect().bottom>top+2);return {key:n?.dataset.historyRowKey,offset:n?n.getBoundingClientRect().top-top:0,rows:p.querySelectorAll('[data-history-row-key]').length,pages:Number(p.dataset.historyPages),scroll:p.scrollTop,height:p.scrollHeight};})()`,
          );
        report.initialBrowser = {
          ...(await view()),
          heap: await memory(),
          historyRequests: readCounts.history,
        };
        assert(report.initialBrowser.rows < 80);
        await page.screenshot(join(directory, "latest.png"));
        phase("load a stationary top edge without a second gesture");
        // Let initial end-following settle, then jump directly to the edge.
        // The old test always clicked Load Earlier and hid a missed scroll wake.
        await page.wait(550);
        const edgeReads = readCounts.history;
        const edgeAt = performance.now();
        await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=0");
        const edgeDeadline = Date.now() + 3000;
        while (readCounts.history === edgeReads && Date.now() < edgeDeadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        report.topEdgeAfterWait = await view();
        assert(readCounts.history > edgeReads, "The top edge waited for another gesture");
        const edgeRequestMs = performance.now() - edgeAt;
        await page.waitFor(
          "Number(document.querySelector('.product-chat-scroll')?.dataset.historyPages)>1 && !document.querySelector('.product-history-controls button')?.disabled",
        );
        report.automaticTopEdge = {
          requests: readCounts.history - edgeReads,
          requestStartedMs: edgeRequestMs,
          milliseconds: performance.now() - edgeAt,
          secondGesture: false,
        };
        phase("browse and evict older pages");
        const heaps = [];
        for (let i = 0; i < 24; i++) {
          if (
            !(await page.evaluate(
              "Boolean(document.querySelector('.product-history-controls button'))",
            ))
          )
            break;
          const before = readCounts.history;
          await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=0");
          await page.waitFor(
            "!document.querySelector('.product-history-controls button')?.disabled",
          );
          await page.evaluate(
            "document.querySelector('.product-history-controls button')?.click()",
          );
          const until = Date.now() + 30000;
          while (readCounts.history === before && Date.now() < until)
            await new Promise((r) => setTimeout(r, 50));
          assert(
            readCounts.history > before,
            "Paging did not issue a bounded read on iteration " + i,
          );
          await page.waitFor(
            "!document.querySelector('.product-history-controls button')?.disabled",
          );
          const current = await view();
          assert(current.pages <= HISTORY_BROWSER_PAGES);
          assert(current.rows < 100);
          if (i === 7 || i === 15 || i === 23) heaps.push(await memory());
        }
        heaps.push(await memory());
        report.browsing = { heaps, view: await view(), historyRequests: readCounts.history };
        assert(
          heaps.at(-1) - heaps[0] < 32 * 1024 ** 2,
          "Browser retained heap grows with pages already evicted",
        );
        let anchor = await view();
        await page.screenshot(join(directory, "history.png"));
        phase("direct navigation, refresh and disclosure state");
        await page.wait(300);
        const restoreBefore = await view();
        // Dispatch a normal scroll so the reader saves only an anchor, not bodies.
        await page.evaluate(
          "document.querySelector('.product-chat-scroll').dispatchEvent(new Event('scroll'))",
        );
        await page.wait(400);
        await page.send("Page.reload", { ignoreCache: true });
        await page.waitFor("document.querySelector('.product-return-to-latest')", 30000);
        await page.wait(500);
        const restoreAfter = await view();
        report.bookmark = { before: restoreBefore, after: restoreAfter };
        assert.equal(restoreAfter.key, restoreBefore.key);
        assert(
          Math.abs(restoreAfter.offset - restoreBefore.offset) < 6,
          "Refresh lost the reading offset",
        );
        const beforeJump = readCounts.history;
        await page.evaluate("document.querySelector('.product-history-search-toggle').click()");
        await page.evaluate(
          `(()=>{const i=document.querySelector('.product-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'HISTORY_FIXTURE_END');i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await page.evaluate(
          "document.querySelector('.product-history-search form').requestSubmit()",
        );
        await page.waitFor("document.querySelector('.product-history-hit')", 30000);
        await page.evaluate("document.querySelector('.product-history-hit').click()");
        await page.waitFor(
          "document.querySelector('.product-chat-scroll').textContent.includes('HISTORY_FIXTURE_END')",
          30000,
        );
        assert(readCounts.history - beforeJump <= 2, "Direct search jump walked intervening pages");
        report.directBrowserJump = true;
        // Tool search uses the same cursor but must expose the matching result.
        await page.evaluate("document.querySelector('.product-history-search-toggle').click()");
        await page.evaluate(
          `(()=>{const i=document.querySelector('.product-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify("fixture-" + (units - 1) + ".txt")});i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await page.evaluate(
          "document.querySelector('.product-history-search form').requestSubmit()",
        );
        await page.waitFor("document.querySelector('.product-history-hit')", 30000);
        await page.evaluate("document.querySelector('.product-history-hit').click()");
        await page.waitFor(
          "document.querySelector('.product-tool[data-tool-name=read] .product-tool-text')",
          30000,
        );
        report.toolSearchVisible = true;
        await page.evaluate(
          `document.querySelector('[data-history-row-key$="activity:tool:task:${lastToolId}"] .product-tool-text button').click()`,
        );
        await page.waitFor("document.querySelector('.product-large-code')", 10000);
        await page.wait(350);
        const toolKey = await page.evaluate(
          "document.querySelector('.product-large-code').closest('[data-history-row-key]').dataset.historyRowKey",
        );
        await page.evaluate(`document.querySelector('.product-chat-scroll').scrollTop=${2200}`);
        await page.wait(300);
        assert(
          !(await page.evaluate(
            `Boolean(document.querySelector('[data-history-row-key="${toolKey}"]'))`,
          )),
          "Tool row did not leave virtual range",
        );
        await page.evaluate(
          "document.querySelector('.product-chat-scroll').scrollTop=document.querySelector('.product-chat-scroll').scrollHeight",
        );
        await page.waitFor("document.querySelector('.product-large-code')", 10000);
        report.virtualDisclosureRetained = true;
        // A late image size above the visible row must not shift reading.
        await page.evaluate("document.querySelector('.product-history-search-toggle').click()");
        await page.evaluate(
          `(()=>{const i=document.querySelector('.product-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify("History marker " + (units - 32))});i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await page.evaluate(
          "document.querySelector('.product-history-search form').requestSubmit()",
        );
        await page.waitFor("document.querySelector('.product-history-hit')", 30000);
        await page.evaluate("document.querySelector('.product-history-hit').click()");
        await page.wait(500);
        const resizedBefore = await view();
        const inserted = await page.evaluate(
          `(()=>{const p=document.querySelector('.product-chat-scroll'),top=p.getBoundingClientRect().top;const previous=[...p.querySelectorAll('[data-history-row-key]')].filter(n=>n.getBoundingClientRect().bottom<=top+1).at(-1);if(!previous)return false;const image=new Image();image.id='delayed-history-image';image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII=';image.style.cssText='display:block;width:200px;height:480px';previous.append(image);return true;})()`,
        );
        assert(inserted, "Fixture has no overscan row for delayed image measurement");
        await page.wait(400);
        const resizedAfter = await view();
        report.imageResize = { before: resizedBefore, after: resizedAfter };
        assert.equal(resizedAfter.key, resizedBefore.key);
        assert(
          Math.abs(resizedAfter.offset - resizedBefore.offset) < 6,
          "Delayed image changed the reading offset",
        );
        report.delayedImageAnchor = true;
        await page.evaluate("document.getElementById('delayed-history-image').remove()");

        // Establish an actual reading gesture after the layout guard, then verify its saved anchor.
        await page.wait(600);
        await page.evaluate(
          "(()=>{const p=document.querySelector('.product-chat-scroll');p.scrollTop=Math.max(500,p.scrollTop-1500);p.dispatchEvent(new Event('scroll'));})()",
        );
        await page.wait(500);
        report.beforeLiveBookmark = await page.evaluate(
          `JSON.parse(sessionStorage.getItem('pi-cloud:reading:'+${JSON.stringify(session.sessionId)})??'null')`,
        );
        assert(report.beforeLiveBookmark?.query, "Reading gesture did not persist a bookmark");
        await page.send("Page.reload", { ignoreCache: true });
        await page.waitFor("document.querySelector('.product-return-to-latest')", 30000);
        await page.wait(500);
        phase("continue live output while history stays anchored");
        anchor = await view();
        const next = await store.acceptTurn(session.sessionId, randomUUID(), {
          prompt: "Synthetic live continuation",
        });
        await db
          .updateTable("runs")
          .set({ state: "running", started_at: new Date() })
          .where("id", "=", next.runId)
          .execute();
        await db
          .updateTable("sessions")
          .set({ state: "running" })
          .where("id", "=", session.sessionId)
          .execute();
        const events = createPiCloudEventFactory(
          { sessionId: session.sessionId, turnId: next.turnId, agentId: "root" },
          { initialSequence: seq + 1 },
        );
        live.accept(
          tenant.tenantId,
          events.next({ type: "turn.started", payload: { inputKind: "prompt" } }),
        );
        for (let i = 0; i < 600; i++) {
          const id = nextId++;
          const text = `LIVE_HISTORY_${i} ` + "small streaming text ".repeat(35);
          await publish([assistant(id, text)], next);
          const event = events.next({
            type: "assistant.text.delta",
            payload: { text, messageId: `entry:${id}:0`, phase: "final_answer" },
          });
          await db
            .updateTable("runs")
            .set({ output_display_seq: String(event.seq), output_display_native_seq: String(seq) })
            .where("id", "=", next.runId)
            .execute();
          live.accept(tenant.tenantId, event);
          live.cover(tenant.tenantId, session.sessionId, event.seq);
        }
        const ended = events.next({ type: "turn.completed", payload: { stopReason: "stop" } });
        await db
          .updateTable("runs")
          .set({
            state: "completed",
            settled_at: new Date(),
            stop_reason: "stop",
            output_display_seq: String(ended.seq),
          })
          .where("id", "=", next.runId)
          .execute();
        await db
          .updateTable("sessions")
          .set({ state: "idle", next_event_seq: String(ended.seq + 1) })
          .where("id", "=", session.sessionId)
          .execute();
        live.accept(tenant.tenantId, ended);
        const after = await view();
        report.liveWhileBrowsing = { before: anchor, after };
        assert.equal(after.key, anchor.key);
        assert(
          Math.abs(after.offset - anchor.offset) < 5,
          "Live output moved the reading position",
        );
        await page.evaluate("document.querySelector('.product-return-to-latest').click()");
        await page.waitFor(
          "document.querySelector('.product-chat-scroll')?.textContent.includes('LIVE_HISTORY_599')",
          30000,
        );
        report.returnedToLatest = true;
        assert.deepEqual(await page.evaluate("historyErrors"), []);
        await page.screenshot(join(directory, "continued.png"));
      } catch (error) {
        await page.screenshot(join(directory, "failure.png"));
        report.browserErrors = await page.evaluate("historyErrors").catch(() => []);
        report.browserFailure = await page
          .evaluate(
            "({url:location.href,ready:document.readyState,body:document.body.innerText.slice(0,1000),resources:performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,duration:e.duration,size:e.transferSize}))})",
          )
          .catch(() => null);
        throw error;
      }
    },
  );
  if (process.env.PI_CLOUD_FORK_RETENTION_CHECK === "1") {
    phase("fork and retire real 1 GiB native history");
    const tree = new ConversationTreeService({ database: db });
    const resident = [];
    const sampler = setInterval(() => resident.push(process.memoryUsage().rss), 100);
    sampler.unref();
    try {
      const inventory = async () =>
        (
          await sql`select count(*)::int as objects,coalesce(sum(payload_bytes),0)::text as bytes
        from pi_history_bodies where tenant_id=${tenant.tenantId}::uuid and body_kind='entry'`.execute(
            db,
          )
        ).rows[0];
      const before = await inventory(),
        started = performance.now();
      const fork = await tree.fork(tenant.tenantId, session.sessionId, randomUUID(), {
        turnId: run.turnId,
        entryId: String(final),
      });
      const firstMs = performance.now() - started;
      phase("first independent Fork retained");
      const forkPage = await store.getConversation(fork.session.sessionId);
      assert(JSON.stringify(forkPage).includes("HISTORY_FIXTURE_END"));
      const toolPage = await store.getConversation(fork.session.sessionId, {
        turnId: run.turnId,
        toolCallId: `task:${lastToolId}`,
      });
      const tool = toolPage.turns
        .flatMap((t) => t.transcript?.items ?? [])
        .find((i) => i.kind === "tool" && i.toolCallId === `task:${lastToolId}`);
      assert.equal(tool?.input.path, `fixture-${units - 1}.txt`);
      assert(
        JSON.stringify(tool?.output).includes(`Result ${units - 1} `),
        "Frozen metadata selected another record body",
      );
      assert.equal(
        (await inventory()).objects,
        before.objects,
        "Fork duplicated immutable Entry bodies",
      );
      const nestedAt = performance.now();
      const nested = await tree.fork(tenant.tenantId, fork.session.sessionId, randomUUID(), {
        turnId: run.turnId,
        entryId: String(final),
      });
      const nestedMs = performance.now() - nestedAt;
      phase("nested independent Fork retained");
      const pending = await store.acceptTurn(fork.session.sessionId, randomUUID(), {
        prompt: "Queued isolated fork work",
      });
      const pruneAt = performance.now();
      await tree.prune(tenant.tenantId, session.sessionId, randomUUID(), {
        turnId: run.turnId,
        entryId: String(final),
      });
      const pruneMs = performance.now() - pruneAt;
      assert.equal(
        (
          await db
            .selectFrom("runs")
            .select("state")
            .where("id", "=", pending.runId)
            .executeTakeFirstOrThrow()
        ).state,
        "queued",
      );
      assert.equal(
        (
          await db
            .selectFrom("pi_sessions")
            .select("id")
            .where("id", "=", binding.pi_session_id)
            .execute()
        ).length,
        0,
      );
      let collected = 0;
      for (;;) {
        const n = await reapUnreferencedEntryBodies(db, 1024);
        collected += n;
        if (n < 1024) break;
      }
      const after = await inventory();
      assert.equal(
        after.objects,
        before.objects - 600,
        "Discarded live suffix still has a body owner",
      );
      for (const id of [session.sessionId, fork.session.sessionId, nested.session.sessionId]) {
        const page = await store.getConversation(id);
        assert(JSON.stringify(page).includes("HISTORY_FIXTURE_END"));
        const prior = await store.getConversation(id, { before: page.history.before });
        assert(prior.turns.length > 0);
      }
      const metadata = (
        await sql`select count(*)::int as objects,coalesce(sum(payload_bytes),0)::text as bytes from pi_history_bodies
        where tenant_id=${tenant.tenantId}::uuid and body_kind='metadata'`.execute(db)
      ).rows[0];
      const referenceRows = {};
      for (const table of ["pi_durable_writes", "pi_durable_records", "pi_history_snapshots"])
        referenceRows[table] = (
          await sql`
        select count(*)::int as rows,coalesce(sum(pg_column_size(r)),0)::text as rowBytes from ${sql.id(table)} r where tenant_id=${tenant.tenantId}::uuid`.execute(
            db,
          )
        ).rows[0];
      report.forkRetention = {
        before,
        after,
        metadata,
        referenceRows,
        collected,
        firstMs,
        nestedMs,
        pruneMs,
        peakRss: Math.max(...resident),
      };
    } finally {
      clearInterval(sampler);
    }
  }
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.stack ?? error).slice(0, 2000);
} finally {
  await vite?.close();
  await app?.close();
  live.close();
  await readDb?.destroy();
  await db.destroy();
  await admin.query(`drop database "${databaseName}"`);
  await admin.end();
  if (cache) await rm(cache, { recursive: true, force: true });
  await save();
  console.log(JSON.stringify(report));
  if (failure) throw failure;
}
