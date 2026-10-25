import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createSession } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDatabase } from "../packages/database/src/index.ts";
import { assertIdleNativeSession } from "../packages/pi-session-postgres/src/idle-session-mutation.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
  readNativeCompaction,
} from "../packages/pi-session-postgres/src/durable/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { uploadRelativePath } from "../packages/protocol/src/user-upload.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { crashOwnedWorker } from "./lib/owned-worker-crash.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(process.env.PI_CLOUD_LIVE_COMMANDS_CHECK, "1", "Authorize owned Luna/Cube fixtures");
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/conversation-commands",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = {
  at: new Date().toISOString(),
  accepted: false,
  cleanupConfirmed: false,
  checks: {},
};
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 3 });
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
const compactTerminal = (r) =>
  r && ["applied", "no_op", "stale", "cancelled", "failed"].includes(r.state);
async function until(read, label, budget = 600000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out`);
}
let tenant, api, project, failure;
const sessions = [];
const runs = (id) =>
  db
    .selectFrom("runs")
    .select(["id", "turn_id", "state", "operation_kind", "worker_id", "lease_id"])
    .where("session_id", "=", id)
    .orderBy("created_at")
    .execute();
const settled = (id) =>
  until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : false;
  }, "Run settlement");
const compactSettled = (session, id) =>
  until(async () => {
    const r = await api.getCompaction(session.sessionId, id);
    if (r?.state === "failed") {
      const run = await api.getRun(r.runId);
      const scope = await scopeOf(session);
      const tasks = await new DurablePostgresProjection(db, scope).scan({ kind: "task" }, 64);
      report.failedCommand = {
        command: r,
        state: run.state,
        failure: run.failure,
        tasks: tasks.map((t) => ({
          id: t.value.id,
          kind: t.value.kind,
          state: t.value.state.status,
          ...(t.value.state.status === "terminal" ? { outcome: t.value.state.outcome } : {}),
        })),
      };
      await save();
    }
    return compactTerminal(r) ? r : false;
  }, "Native summary placement");
const scopeOf = async (session) => {
  const row = await db
    .selectFrom("sessions")
    .select(["pi_session_id", "pi_conversation_id"])
    .where("id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  return {
    tenantId: tenant.tenantId,
    sessionId: row.pi_session_id,
    conversationId: Number(row.pi_conversation_id ?? 1),
  };
};

// Synthetic context only, under the same quiescent administrative lock as a fork.
// No Harness runs in the API, and no active writer or model credentials are bypassed.
async function seed(session) {
  const scope = await scopeOf(session);
  await db.transaction().execute(async (tx) => {
    await assertIdleNativeSession(tx, scope.tenantId, scope.sessionId);
    const projection = new DurablePostgresProjection(tx, scope);
    const storage = await PublishedDurableStorage.open({
      projection,
      publish: (batch) => projection.applyIn(tx, batch),
      waitProjected: async () => {},
    });
    const kernel = createSession(storage);
    try {
      await kernel.commit(async (change) => {
        let id = scope.conversationId;
        if (!(await storage.conversation(id, BACKGROUND_CONTEXT))) {
          id = (await change.createConversation({ ownership: { kind: "ownerless" } })).id;
          assert(id !== 1, "Exercise a writable non-reserved Conversation identity");
          await tx
            .updateTable("sessions")
            .set({ pi_conversation_id: id })
            .where("id", "=", session.sessionId)
            .execute();
        }
        for (let i = 0; i < 4; i++) {
          await change.appendEntry(id, {
            kind: "pi.user",
            model: [
              {
                role: "user",
                timestamp: Date.now(),
                content:
                  `Synthetic acceptance context. The project codename is ORCHID_271. Keep this fact. Batch ${i}.\n` +
                  "Completed decisions: retain PostgreSQL control, native Pi tasks, ordered Kafka publication, isolated Cube tools.\n".repeat(
                    600,
                  ),
              },
            ],
          });
          await change.appendEntry(id, {
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-6-luna",
                content: [{ type: "text", text: "The project codename is ORCHID_271." }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            ],
          });
        }
      }, BACKGROUND_CONTEXT);
    } finally {
      await kernel.close(BACKGROUND_CONTEXT);
    }
  });
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-commands-${randomUUID()}`,
    ownerDisplayName: "Conversation command acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  await save();
  api = new PiCloudApi(
    (url, init) =>
      fetch(
        new URL(String(url), `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`),
        init,
      ),
    tenant.credential.token,
  );
  project = await api.createProject("Conversation commands acceptance");
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Synthetic command context",
    "elastic",
  );
  sessions.push(session);
  await seed(session);
  phase("cold usage and manual compaction without Cube");
  const before = await api.getConversationUsage(session.sessionId);
  assert.deepEqual(
    (await api.getConversation(session.sessionId)).turns,
    [],
    "No unrelated conversation may enter this new fixture",
  );
  assert.equal((await runs(session.sessionId)).length, 0);
  let cold, key;
  await withChromePage(
    { profilePrefix: "pi-cloud-commands-", width: 1280, height: 900 },
    async (page) => {
      // Only authentication is supplied by the fixture. All responses and SSE are live.
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
      localStorage.setItem("pi-cloud:ui-language", "zh-CN");
      const originalFetch=window.fetch.bind(window);
      window.fetch=async (input,init={})=>{
        const url=new URL(input instanceof Request?input.url:String(input),location.href);
        const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
        const owned=url.origin===location.origin && url.pathname.startsWith('/v1/');
        if(owned)headers.set('authorization',${JSON.stringify("Bearer " + tenant.credential.token)});
        const compact=owned&&url.pathname.endsWith('/compact')&&init.method==='POST';
        if(compact)window.commandKey=headers.get('idempotency-key');
        const response=await originalFetch(input,{...init,headers});
        if(compact&&response.ok)window.commandAccepted=await response.clone().json();
        return response;
      };`,
      });
      await page.navigate(
        `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}/?session=${session.sessionId}`,
      );
      await page.waitFor("document.querySelector('.product-composer textarea')");
      await page.waitFor(
        "document.querySelector('.product-topbar-title strong')?.textContent==='Synthetic command context'",
      );
      const enter = async (text) => {
        await page.evaluate(
          `(()=>{const input=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`,
        );
        await page.evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      };
      try {
        await enter("/usage");
        await page.waitFor("document.querySelector('.product-usage-panel .product-usage-grid')");
        assert.equal((await runs(session.sessionId)).length, 0);
        await page.screenshot(resolve(directory, "usage.png"));
        await enter("/compact Keep project codename and architecture decisions.");
        await page.waitFor("window.commandAccepted");
        cold = await page.evaluate("window.commandAccepted");
        key = await page.evaluate("window.commandKey");
        assert.equal((await compactSettled(session, cold.commandId)).state, "applied");
        await page.waitFor("document.querySelector('.product-compact-status.applied')", 30000);
        await page.screenshot(resolve(directory, "compact-applied.png"));
        report.checks.browser = { liveUsage: true, inputCompact: true, appliedVisible: true };
      } catch (error) {
        await page.screenshot(resolve(directory, "browser-failure.png"));
        throw error;
      }
    },
  );
  assert.equal(cold.initialOperation, true);
  assert.equal(
    (
      await api.compactConversation(
        session.sessionId,
        "Keep project codename and architecture decisions.",
        key,
      )
    ).commandId,
    cold.commandId,
  );
  assert.equal((await compactSettled(session, cold.commandId)).state, "applied");
  assert.equal((await settled(cold.runId)).state, "completed");
  assert.equal((await runs(session.sessionId)).length, 1);
  const after = await api.getConversationUsage(session.sessionId);
  assert(after.tokens.total > before.tokens.total, "Summary usage must be counted");
  assert(
    after.context.estimatedTokens < before.context.estimatedTokens,
    "Summary must reduce active context",
  );
  assert.equal(
    (
      await db
        .selectFrom("workspace_runtimes")
        .select("workspace_runtime_id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute()
    ).length,
    0,
  );
  report.checks.cold = {
    before: before.context.estimatedTokens,
    after: after.context.estimatedTokens,
    tokens: after.tokens,
    conversationId: (await scopeOf(session)).conversationId,
  };
  await save();

  phase("same-Run compact during a native Tool and subsequent continuation");
  await until(
    async () =>
      !(
        await db
          .selectFrom("session_leases")
          .select("lease_id")
          .where("tenant_id", "=", tenant.tenantId)
          .where("released_at", "is", null)
          .execute()
      ).length,
    "idle writer retirement",
  );
  await seed(session);
  const uploadId = randomUUID(),
    filename = "compact-unblock.txt";
  const path = `/workspace/${uploadRelativePath(uploadId, filename)}`;
  const active = await api.acceptTurn(
    session.sessionId,
    `Use bash once with timeout 300 to run exactly: while [ ! -f '${path}' ]; do sleep 1; done; cat '${path}'; echo COMPACT_TOOL_DONE. The operator will upload that file. Then reply with the project codename from history.`,
    newIdempotencyKey("active-compact"),
  );
  await until(async () => {
    if (terminal(await api.getRun(active.runId)))
      throw new Error("Fixture ended before waiting Tool");
    return nativeMessages(await nativeHistory(db, { runId: active.runId })).some(
      (m) =>
        m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.name === "bash"),
    );
  }, "Complete Tool call");
  const count = (await runs(session.sessionId)).length;
  const overlap = await api.compactConversation(
    session.sessionId,
    "Keep the project codename and pending tool.",
    newIdempotencyKey("active-command"),
  );
  assert.equal(overlap.runId, active.runId);
  assert.equal(overlap.initialOperation, false);
  await until(
    async () => {
      const current = await api.getCompaction(session.sessionId, overlap.commandId);
      if (current?.state === "failed") throw new Error("Active compaction failed");
      return current?.state === "awaiting_placement" ? current : false;
    },
    "Summary waiting for Tool boundary",
    240000,
  );
  await api.uploadWorkspaceFile(
    session.sessionId,
    uploadId,
    new Blob(["COMPACT_GATE_OPEN"]),
    filename,
  );
  assert.equal((await settled(active.runId)).state, "completed");
  assert.equal((await compactSettled(session, overlap.commandId)).state, "applied");
  assert.equal((await runs(session.sessionId)).length, count);
  const messages = nativeMessages(await nativeHistory(db, { runId: active.runId }));
  assert(
    messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some((p) => p.type === "text" && p.text.includes("ORCHID_271")),
    ),
  );
  report.checks.active = { sameRun: true, waitedForPlacement: true, factRetained: true };
  await save();

  if (process.env.PI_CLOUD_COMMANDS_RESTART_CHECK === "1") {
    phase("ordered Worker recovery of the same native compaction task");
    await until(
      async () =>
        !(
          await db
            .selectFrom("session_leases")
            .select("lease_id")
            .where("tenant_id", "=", tenant.tenantId)
            .where("released_at", "is", null)
            .execute()
        ).length,
      "idle writer retirement",
    );
    await seed(session);
    const accepted = await api.compactConversation(
      session.sessionId,
      "Keep ORCHID_271 and architecture decisions.",
      newIdempotencyKey("recover-compact"),
    );
    const scope = await scopeOf(session);
    const receipt = await until(async () => {
      const r = await readNativeCompaction(db, scope, accepted.commandId);
      return r?.state === "summarizing" ? r : false;
    }, "native compaction admission");
    const own = (await runs(session.sessionId)).find((r) => r.id === accepted.runId);
    const crash = await crashOwnedWorker(db, tenant.tenantId, accepted.runId);
    assert.equal((await compactSettled(session, accepted.commandId)).state, "applied");
    assert.equal((await settled(accepted.runId)).state, "completed");
    const recovered = await readNativeCompaction(db, scope, accepted.commandId);
    assert.equal(recovered.taskId, receipt.taskId);
    assert.notEqual(
      (await runs(session.sessionId)).find((r) => r.id === accepted.runId).lease_id,
      own.lease_id,
    );
    report.checks.recovery = { sameRun: true, sameTask: true, successorLease: true, crash };
  }
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 700);
} finally {
  try {
    for (const session of sessions) {
      for (const row of await runs(session.sessionId))
        if (!terminal(row)) {
          await api.cancelTurn(
            session.sessionId,
            row.turn_id,
            newIdempotencyKey("cleanup-command"),
          );
          await settled(row.id);
        }
      await until(
        async () =>
          !(
            await db
              .selectFrom("session_leases")
              .select("lease_id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("released_at", "is", null)
              .execute()
          ).length,
        "writer cleanup",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(
        project.workspaceId,
        newIdempotencyKey("cleanup-command-workspace"),
      );
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "physical Workspace purge",
      );
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .execute()
          ).length,
        "control cleanup",
      );
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"),
            "utf8",
          ),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    failure ??= error;
    report.cleanupFailure = String(error?.message ?? error).slice(0, 500);
  }
  await db.destroy();
  await save();
  console.log(JSON.stringify(report));
  if (failure) throw failure;
}
