import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createSession, StorageRejected } from "@earendil-works/pi-durable";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { testKafka } from "../../lib/test-kafka.mjs";
import { openJournalBackend, until, deferred, viewEntries } from "./journal.mjs";
import { openHarness, remoteAdapter, ctx, answer, call } from "./harness.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const results = [];
const report = {
  format: "pi-cloud.pi-durable-evaluation.v1",
  checkedAt: new Date().toISOString(),
  baselineRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  upstreamVersion: "1.0.0",
  productionPiVersion: "0.84.1",
  acceptanceCompleted: false,
  productionAdoption: false,
  topology: "disposable PostgreSQL and three RF3 Kafka brokers; controlled remote endpoint",
  results,
  limitations: [
    "Fixture grants exercise the existing ingress, not production PG admission or its HTTP routing",
    "Private probe envelopes require a production schema and projection design before adoption",
    "Cold fixture restore replays all PG batches; bounded production bootstrap is not implemented",
    "No real model or physical-node HA claim",
  ],
  cleanupConfirmed: false,
};
let pg, kafka, backend;
async function check(name, fn) {
  const start = performance.now();
  const data = await fn();
  results.push({
    name,
    verified: true,
    compatible: data?.compatible ?? true,
    elapsedMs: Math.round(performance.now() - start),
    ...data,
  });
  console.log(JSON.stringify(results.at(-1)));
}
async function closeHarness(harness, store, sessionId) {
  await harness.close(ctx);
  await backend.waitProjected(sessionId, store.commits.at(-1)?.seq ?? 1);
}
const toolResponses = () => [
  answer(call("remote", { value: "probe" }), { stopReason: "toolUse" }),
  answer("DONE"),
];

try {
  pg = await testPostgres();
  kafka = await testKafka();
  backend = await openJournalBackend({ brokers: kafka.brokers, databaseUrl: pg.url });
  await check("Kafka ACK precedes view publication; PG projection is asynchronous", async () => {
    const gate = deferred(),
      prepared = deferred();
    const { store, sessionId } = await backend.open(undefined, {
      before: async () => {
        prepared.resolve();
        await gate.promise;
      },
    });
    const session = createSession(store);
    let visible = 0;
    session.subscribeCommits(() => visible++);
    backend.pauseProjection();
    let newId;
    const pending = session.commit(async (tx) => {
      const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
      newId = c.id;
      return c.id;
    }, ctx);
    await prepared.promise;
    assert.equal(visible, 0);
    assert.equal(await store.conversation(newId, ctx), undefined);
    gate.resolve();
    await pending;
    assert.equal(visible, 1);
    assert.equal((await store.conversation(newId, ctx)).id, newId);
    assert.equal((await backend.rows(sessionId)).length, 0, "Hot commit waited for PG");
    backend.resumeProjection();
    await backend.waitProjected(sessionId, 1);
    assert.equal(await backend.duplicate(sessionId, (await backend.rows(sessionId))[0]), false);
    await assert.rejects(backend.duplicate(sessionId, { seq: 1, writes: [] }));
    await session.close(ctx);
    return {
      visibleBeforeAck: 0,
      rowsAtAck: 0,
      atomicBatches: 1,
      duplicateProjectionIgnored: true,
    };
  });
  await check(
    "Ambiguous commit poisons the old Session but PG recovers committed bytes",
    async () => {
      const { store, sessionId } = await backend.open(undefined, {
        afterPublication: () => {
          throw new Error("lost_ack");
        },
      });
      const session = createSession(store);
      let visible = 0;
      session.subscribeCommits(() => visible++);
      await assert.rejects(
        session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx),
        /lost_ack/,
      );
      await assert.rejects(
        session.commit(() => {}, ctx),
        /poisoned/,
      );
      assert.equal(visible, 0);
      await backend.waitProjected(sessionId, 1);
      const recovered = await backend.open(sessionId);
      assert.equal(
        (await recovered.store.scanConversations({}, 10, undefined, ctx)).items.length,
        1,
      );
      await session.close(ctx);
      await recovered.store.close(ctx);
      return {
        observableBeforeConfirmation: false,
        oldWriterRejected: true,
        recoveredBatches: recovered.restoredBatches,
      };
    },
  );
  await check("Proved pre-admission rejection does not poison the Session", async () => {
    const { store, sessionId } = await backend.open();
    const session = createSession(store);
    await assert.rejects(
      session.commit(async (tx) => {
        const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await tx.appendEntry(c.id, {
          kind: "probe.too_large",
          data: { text: "x".repeat(1000000) },
        });
      }, ctx),
      StorageRejected,
    );
    assert.equal(store.failed, false);
    assert.equal((await backend.rows(sessionId)).length, 0);
    await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx);
    await backend.waitProjected(sessionId, 1);
    assert.equal((await backend.rows(sessionId)).length, 1);
    await session.close(ctx);
    return {
      rejectedBatchPersisted: false,
      sameSessionRemainsUsable: true,
      scope: "real ingress size rejection; no truncation or retry of an uncertain append",
    };
  });
  await check("An ordered writer seal rejects subsequent Durable commits", async () => {
    const { store, sessionId } = await backend.open();
    const session = createSession(store);
    await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx);
    await backend.closeFixtureWriter(sessionId);
    await assert.rejects(
      session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx),
      /closed/,
    );
    await backend.waitProjected(sessionId, 1);
    assert.equal((await backend.rows(sessionId)).length, 1);
    await session.close(ctx);
    return {
      oldWriterRejected: true,
      acknowledgedBatches: 1,
      scope: "real ingress seal under fixture grant; not PG lease takeover",
    };
  });
  await check(
    "One durable intent carries the remote handoff and original callback identity",
    async () => {
      let effects = 0;
      const adapter = remoteAdapter({
        submit: async (c, reply) => {
          effects++;
          reply({ effect: "completed", text: "REMOTE_OK" });
        },
        cancel: async () => {},
      });
      const { store, sessionId } = await backend.open(undefined, {
        commands: (b) => adapter.commands(b),
      });
      backend.setDispatcher(sessionId, (c) => adapter.dispatch(c));
      const { harness, root, faux } = await openHarness(store, {
        execute: adapter.execute,
        hooks: adapter.hooks,
        responses: toolResponses(),
      });
      await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      assert.equal(effects, 1);
      assert.equal(faux.state.callCount, 2);
      const entries = await viewEntries(harness, root.id);
      const result = entries.find((e) => e.kind === "pi.tool-result");
      assert.equal(result.model[0].details.operationId, adapter.stats.operations[0]);
      const intent = store.commits.find((b) =>
        b.writes.some(
          (w) =>
            w.type === "task" &&
            w.value.kind === "pi.tool" &&
            w.value.state.checkpoint?.phase === "execute",
        ),
      );
      assert(intent);
      await closeHarness(harness, store, sessionId);
      return {
        executions: effects,
        modelRequests: faux.state.callCount,
        intentBatch: intent.seq,
        resultIdentityPreserved: true,
        commits: store.commits.length,
      };
    },
  );
  for (const kind of ["ordinary-error", "not-started", "unknown"])
    await check(`Remote ${kind} sampling policy`, async () => {
      const effect =
        kind === "ordinary-error"
          ? "completed"
          : kind === "not-started"
            ? "not_started"
            : "unknown";
      const adapter = remoteAdapter({
        submit: async (c, reply) =>
          reply({
            effect,
            isError: true,
            text: kind === "ordinary-error" ? "ownership_lost: ordinary application output" : kind,
          }),
        cancel: async () => {},
      });
      const { store, sessionId } = await backend.open(undefined, {
        commands: (b) => adapter.commands(b),
      });
      backend.setDispatcher(sessionId, (c) => adapter.dispatch(c));
      const { harness, root, faux } = await openHarness(store, {
        execute: adapter.execute,
        hooks: adapter.hooks,
        responses: toolResponses(),
      });
      await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      assert.equal(faux.state.callCount, kind === "unknown" ? 1 : 2);
      const entries = await viewEntries(harness, root.id);
      assert.equal(
        entries.find((e) => e.kind === "pi.tool-result").model[0].details.effect,
        effect,
      );
      await closeHarness(harness, store, sessionId);
      return {
        modelRequests: faux.state.callCount,
        effect,
        policy: "PiCloud-owned adapter; no parsing of business output",
      };
    });
  for (const mode of ["unsafe", "safe", "completed"])
    await check(`SIGKILL and reopen: ${mode}`, async () => {
      const sessionId = randomUUID(),
        seen = [];
      let effects = 0,
        childError;
      const child = fork(fileURLToPath(new URL("./crash-worker.mjs", import.meta.url)), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const exited = once(child, "exit");
      let diagnostic = "";
      child.stderr.on("data", (b) => {
        diagnostic = (diagnostic + b).slice(-4096);
      });
      let pending = Promise.resolve();
      child.on("message", (m) => {
        if (m.type === "effect") {
          effects++;
          if (mode !== "completed") child.kill("SIGKILL");
          return;
        }
        if (m.type === "submission") {
          return;
        }
        if (m.type === "failure") {
          childError = new Error(m.message);
          return;
        }
        if (m.type !== "commit") return;
        pending = pending
          .then(async () => {
            await backend.publish(sessionId, m.batch);
            seen.push(m.batch.seq);
            if (
              mode === "completed" &&
              m.batch.writes.some((w) => w.type === "entry" && w.value.kind === "pi.tool-result")
            ) {
              child.kill("SIGKILL");
              return;
            }
            if (child.connected) child.send({ type: "ack", id: m.id });
          })
          .catch((e) => {
            childError = e;
            child.kill("SIGKILL");
          });
      });
      child.send({
        type: "start",
        replay: mode === "safe" ? "safe" : undefined,
        complete: mode === "completed",
      });
      try {
        await Promise.race([
          exited,
          delay(30000).then(() => {
            throw new Error(`Crash fixture hung: ${diagnostic}`);
          }),
        ]);
        await pending;
        if (childError) throw childError;
        assert.equal(effects, 1);
        assert(seen.length > 0);
        await backend.waitProjected(sessionId, Math.max(...seen));
        const { store, restoredBatches } = await backend.open(sessionId);
        const { harness, root, faux } = await openHarness(store, {
          execute: async () => {
            effects++;
            return { content: [{ type: "text", text: "REPLAYED_SAFE" }] };
          },
          replay: mode === "safe" ? "safe" : undefined,
          responses: [answer("RECOVERED")],
        });
        harness.resume();
        await until(async () => {
          const p = await store.scanSubmissions({ conversationId: root.id }, 10, undefined, ctx);
          return p.items.some((s) => s.status === "done");
        }, "recovered submission");
        assert.equal(effects, mode === "safe" ? 2 : 1);
        const entries = await viewEntries(harness, root.id);
        const tool = entries.find((e) => e.kind === "pi.tool-result");
        assert(tool);
        if (mode === "unsafe") assert(tool.data.diagnostics.some((d) => d.code === "interrupted"));
        if (mode === "completed")
          assert(tool.model[0].content.some((p) => p.text === "COMMITTED_RESULT"));
        await closeHarness(harness, store, sessionId);
        return {
          compatible: mode !== "unsafe",
          effects,
          restoredBatches,
          modelRequestsAfterReopen: faux.state.callCount,
          ...(mode === "unsafe"
            ? {
                gap: "Upstream resumes sampling after an interrupted unsafe Tool; PiCloud must gate recovery under a new PG-authorized execution and preserve UNKNOWN.",
              }
            : {}),
        };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    });
  for (const mode of ["cancelled", "completed-race", "not-started-race"])
    await check(`Agent abort and original result: ${mode}`, async () => {
      const started = deferred();
      let deliver;
      const adapter = remoteAdapter({
        submit: async (_c, reply) => {
          deliver = reply;
          started.resolve();
        },
        cancel: async () => {
          deliver({
            effect: mode === "not-started-race" ? "not_started" : "completed",
            isError: mode !== "completed-race",
            text:
              mode === "completed-race"
                ? "CONFIRMED_SUCCESS"
                : mode === "not-started-race"
                  ? "CONFIRMED_NOT_STARTED"
                  : "PARTIAL_BEFORE_CANCEL",
          });
        },
      });
      const { store, sessionId } = await backend.open(undefined, {
        commands: (b) => adapter.commands(b),
      });
      backend.setDispatcher(sessionId, (c) => adapter.dispatch(c));
      const { harness, root, faux } = await openHarness(store, {
        execute: adapter.execute,
        hooks: adapter.hooks,
        responses: toolResponses(),
      });
      const submission = await root.submit({ type: "input", content: "go" }, ctx);
      await started.promise;
      await root.abort(ctx);
      await submission.wait(ctx);
      const entries = await viewEntries(harness, root.id);
      const result = entries.find((e) => e.kind === "pi.tool-result");
      assert(result);
      assert.equal(adapter.stats.cancellations.length, 1);
      assert.equal(adapter.stats.replies.length, 1);
      assert.equal(faux.state.callCount, 1);
      const content = result.model[0].content.map((p) => p.text ?? "").join("\n");
      const expected =
        mode === "completed-race"
          ? "CONFIRMED_SUCCESS"
          : mode === "not-started-race"
            ? "CONFIRMED_NOT_STARTED"
            : "PARTIAL_BEFORE_CANCEL";
      const preserved =
        content.includes(expected) &&
        result.model[0].details?.effect === adapter.stats.replies[0].effect;
      if (!preserved)
        assert(
          result.data.diagnostics.some((d) => d.code === "aborted"),
          "Unexpected cancellation behavior",
        );
      await closeHarness(harness, store, sessionId);
      return {
        compatible: preserved,
        cancelThroughSameLog: true,
        receivedOriginalReply: true,
        originalFinalResultPreserved: preserved,
        ...(preserved
          ? {}
          : {
              gap: "Native abort settlement replaces the confirmed remote final result with the retained live slot; current PiCloud cancellation contract is not preserved.",
            }),
      };
    });
  await check("Stop policy for persisted human follow-ups", async () => {
    const started = deferred(),
      release = deferred();
    const { store, sessionId } = await backend.open();
    const { harness, root } = await openHarness(store, {
      execute: async (_a, _api, c) => {
        started.resolve();
        c.abortSignal.addEventListener("abort", () => release.resolve(), { once: true });
        await release.promise;
        return {};
      },
      responses: toolResponses(),
    });
    await root.submit({ type: "input", content: "go" }, ctx);
    await started.promise;
    const withdrawn = await root.submit(
      { type: "input", content: "withdraw me", requestId: "withdraw" },
      ctx,
    );
    await withdrawn.abort(ctx);
    const queued = await root.submit(
      { type: "input", content: "keep queued", requestId: "pending" },
      ctx,
    );
    await root.abort(ctx);
    const held = await store.submission(queued.id, ctx);
    assert.equal(held.status, "unanswered");
    await closeHarness(harness, store, sessionId);
    return {
      compatible: false,
      withdrawalSupported: true,
      afterStop: held.status,
      gap: "Upstream abort withdraws queued inputs; PiCloud pauses them for explicit Continue queue.",
    };
  });
  report.acceptanceCompleted = true;
  report.storage = {
    projectedBatches: backend.observed.length,
    totalBatchBytes: backend.observed.reduce((n, b) => n + b.bytes, 0),
  };
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  const errors = [];
  for (const close of [() => backend?.close(), () => kafka?.close(), () => pg?.close()])
    try {
      await close();
    } catch (e) {
      errors.push(e.message);
    }
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) {
    report.cleanupErrors = errors;
    process.exitCode = 1;
  }
  report.compatibilityGaps = results.filter((r) => !r.compatible).length;
  const path = resolve(
    process.env.PI_CLOUD_DURABLE_PROBE_REPORT ??
      resolve(repo, "docs/reports/pi-durable-verification-20261005.json"),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: path,
      completed: report.acceptanceCompleted,
      gaps: report.compatibilityGaps,
      cleanup: report.cleanupConfirmed,
      failure: report.failure?.message,
    }),
  );
}
