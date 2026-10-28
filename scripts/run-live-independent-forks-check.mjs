import { createSession } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { assertIdleNativeSession } from "../packages/pi-session-postgres/src/idle-session-mutation.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "../packages/pi-session-postgres/src/durable/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { nativeHistory, imageReferences } from "./lib/native-session-history.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_FORK_CHECK,
  "1",
  "Authorize an owned Luna/Cube history fixture",
);
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/independent-forks",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 3 });
const blobs = new S3ImageBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(
    await readFile(resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"), "utf8"),
  ),
});
const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = {
  at: new Date().toISOString(),
  accepted: false,
  cleanupConfirmed: false,
  checks: [],
};
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
let tenant, api, project, root, failure;
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, budget = 600000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error(label + " timed out");
}
async function settled(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : false;
  }, "Run settlement");
  await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["output_sealed_at", "lease_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !r.lease_id || r.output_sealed_at;
  }, "Ordered writer closure");
  return run;
}
async function ask(session, prompt) {
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("fork-check"),
    "low",
  );
  const run = await settled(accepted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  return accepted;
}
async function anchor(session, turn) {
  const tree = await api.getConversationTree(session.sessionId, "focus");
  const item = tree.branches
    .flatMap((b) => b.entries)
    .filter((e) => e.turnId === turn.turnId && e.finalAssistant)
    .at(-1);
  assert(item, "No complete projected answer");
  return item;
}
async function scope(session) {
  const r = await db
    .selectFrom("sessions")
    .select(["pi_session_id", "pi_conversation_id"])
    .where("id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  return {
    tenantId: tenant.tenantId,
    sessionId: r.pi_session_id,
    conversationId: Number(r.pi_conversation_id),
  };
}
async function runningTool(run) {
  await until(async () => {
    const r = await api.getRun(run.runId);
    if (terminal(r)) throw new Error("Gated Tool Run ended early: " + JSON.stringify(r.failure));
    return (
      await sql`select 1 from pi_durable_records where tenant_id=${tenant.tenantId}::uuid and fields->>'run'=${run.runId}
    and kind='task' and fields->>'nativeKind'='"pi.tool"' and fields->>'status'='running' limit 1`.execute(
        db,
      )
    ).rows.length;
  }, "Cube Tool gate");
}
async function compactionPadding(session) {
  const target = await scope(session);
  await db.transaction().execute(async (tx) => {
    await assertIdleNativeSession(tx, target.tenantId, target.sessionId);
    const projection = new DurablePostgresProjection(tx, target, undefined, "references");
    const storage = await PublishedDurableStorage.open({
      projection,
      publish: (batch) => projection.applyIn(tx, batch),
      waitProjected: async () => {},
    });
    const native = createSession(storage);
    try {
      await native.commit(async (change) => {
        for (let i = 0; i < 4; i++)
          await change.appendEntry(target.conversationId, {
            kind: "pi.user",
            model: [
              {
                role: "user",
                timestamp: Date.now(),
                content:
                  `Synthetic completed-context padding ${i}. No action is requested.\n` +
                  "The previous decisions preserve native tasks, ordered publication, isolated execution, and immutable history.\n".repeat(
                    600,
                  ),
              },
            ],
          });
      }, BACKGROUND_CONTEXT);
    } finally {
      await native.close(BACKGROUND_CONTEXT);
    }
  });
}
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-forks-" + randomUUID().slice(0, 16),
    ownerDisplayName: "Independent history acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  await save();
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("Independent history acceptance", { kind: "empty" });
  root = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Fork source",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  const codeB = "B_" + randomUUID().replaceAll("-", "").slice(0, 12),
    codeC = "C_" + randomUUID().replaceAll("-", "").slice(0, 12);
  phase("real accepted input and image history");
  await ask(
    root,
    "This is an isolated acceptance session. Reply exactly ROOT_A. Do not use tools.",
  );
  const b = await ask(root, `Remember code B: ${codeB}. Reply exactly ROOT_B. Do not use tools.`),
    bAnchor = await anchor(root, b);
  const imageCommand = `node -e "require('/opt/pi-cloud/node_modules/sharp')({create:{width:128,height:128,channels:3,background:{r:40,g:90,b:180}}}).png().toFile('/workspace/fork-check.png').then(()=>console.log('PNG_READY')).catch(e=>{console.error(e.message);process.exitCode=1})"`;
  const c = await ask(
      root,
      `Remember code C: ${codeC}. Use bash to execute this exact command:\n${imageCommand}\nThen call show_image on /workspace/fork-check.png. Finish with ROOT_C. This is a synthetic fixture image.`,
    ),
    cAnchor = await anchor(root, c);
  const original = await scope(root),
    images = imageReferences(await nativeHistory(db, { ...original, turnId: c.turnId }));
  await writeFile(
    resolve(directory, "image-turn.json"),
    JSON.stringify(await nativeHistory(db, { ...original, turnId: c.turnId }), null, 2),
    { mode: 0o600 },
  );
  assert(images.length > 0, "The image did not enter native history");
  const d = await api.acceptTurn(
    root.sessionId,
    "Use bash to run sleep 20 and then printf 'D_GATE_DONE'. Do not start a background process. Finish with ROOT_D.",
    newIdempotencyKey("source-gate"),
    "low",
  );
  await runningTool(d);
  phase("Fork from completed C while source D is active");
  const fork = await api.forkConversation(
    root.sessionId,
    c.turnId,
    cAnchor.entryId,
    "Retained independent branch",
    newIdempotencyKey("fork"),
  );
  assert.equal((await settled(d.runId)).state, "completed");
  const f = await api.acceptTurn(
    fork.session.sessionId,
    "Use bash to run sleep 20 and then printf F_GATE_DONE. Do not background it. Then return the remembered code C, without reading files or using any other tools.",
    newIdempotencyKey("fork-gate"),
    "low",
  );
  await runningTool(f);
  phase("Prune source to B while independent Fork F is active");
  const pruned = await api.pruneConversation(
    root.sessionId,
    b.turnId,
    bAnchor.entryId,
    newIdempotencyKey("prune"),
  );
  assert.equal(pruned.prunedSessionCount, 0);
  assert.equal((await settled(f.runId)).state, "completed");
  const forkView = await api.getConversation(fork.session.sessionId);
  const fText = JSON.stringify(forkView.turns.find((t) => t.turnId === f.turnId)?.transcript);
  assert(fText.includes(codeC), "Fork lost its native inherited model context");
  assert(
    forkView.turns.some((t) => t.turnId === c.turnId),
    "Fork lost the source C header",
  );
  const rootView = await api.getConversation(root.sessionId);
  assert(!rootView.turns.some((t) => t.turnId === c.turnId || t.turnId === d.turnId));
  assert.notEqual((await scope(root)).sessionId, original.sessionId);
  assert.equal(
    (
      await db
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .where("id", "=", original.sessionId)
        .execute()
    ).length,
    0,
  );
  for (const image of images) {
    const response = await fetch(
      `${origin}/v1/sessions/${fork.session.sessionId}/images/${image.id}`,
      { headers: { authorization: "Bearer " + tenant.credential.token } },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, image.byteLength);
  }
  report.checks.push({
    activeSourceFork: true,
    busyForkPrune: true,
    oldPhysicalStoreRetired: true,
    forkModelRecalledC: true,
    imageObjects: images.length,
  });
  await save();
  phase("cold continuation and native compaction");
  const e = await ask(root, "Without using tools, return the remembered code B.");
  assert(
    JSON.stringify(
      (await api.getConversation(root.sessionId)).turns.find((t) => t.turnId === e.turnId)
        ?.transcript,
    ).includes(codeB),
  );
  assert(
    !JSON.stringify(await nativeHistory(db, await scope(root))).includes(codeC),
    "Source retained discarded C context",
  );
  await compactionPadding(fork.session);
  const compact = await api.compactConversation(
    fork.session.sessionId,
    "Retain the remembered codes B and C.",
    newIdempotencyKey("compact"),
  );
  const result = await until(async () => {
    const r = await api.getCompaction(fork.session.sessionId, compact.commandId);
    return r && ["applied", "no_op", "stale", "cancelled", "failed"].includes(r.state) ? r : false;
  }, "Fork compaction");
  assert.equal(result.state, "applied", JSON.stringify(result));
  await settled(result.runId);
  const resumed = await ask(fork.session, "Return the remembered code C without using tools.");
  assert(
    JSON.stringify(
      (await api.getConversation(fork.session.sessionId)).turns.find(
        (t) => t.turnId === resumed.turnId,
      )?.transcript,
    ).includes(codeC),
  );
  report.checks.push({
    sourceColdContextB: true,
    sourceDiscardedC: true,
    forkCompaction: true,
    postCompactionRecallC: true,
  });
  phase("real browser navigation and retained image");
  await withChromePage(
    { profilePrefix: "pi-cloud-independent-history-", width: 1280, height: 900 },
    async (page) => {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `const originalFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{const u=new URL(input instanceof Request?input.url:String(input),location.href);const h=new Headers(init.headers??(input instanceof Request?input.headers:undefined));if(u.origin===location.origin&&u.pathname.startsWith('/v1/'))h.set('authorization',${JSON.stringify("Bearer " + tenant.credential.token)});return originalFetch(input,{...init,headers:h});};`,
      });
      await page.navigate(`${origin}/?session=${fork.session.sessionId}`);
      await page.waitFor("document.querySelector('.product-composer textarea')", 30000);
      await page.waitFor(
        `document.querySelector('.product-tree-nav')?.textContent.includes('ROOT_C')`,
        30000,
      );
      await page.screenshot(resolve(directory, "independent-fork.png"));
    },
  );
  report.checks.push({ browserFocusIndependent: true });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.stack ?? error).slice(0, 4000);
} finally {
  try {
    if (tenant && api) {
      const sessions = await db
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      for (const s of sessions) {
        const rows = await db
          .selectFrom("runs")
          .select(["id", "turn_id"])
          .where("session_id", "=", s.id)
          .execute();
        await settleOwnedAcceptanceRuns(api, s.id, rows, settled);
      }
      if (root) await api.deleteConversation(root.sessionId);
      if (project) {
        await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
        await until(
          async () =>
            (
              await db
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", project.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          "Fixture Workspace purge",
        );
      }
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
        "Fixture controls",
      );
      await purgeOwnedAcceptanceTenant(db, tenant, blobs);
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error);
    failure ??= error;
  }
  await save();
  blobs.close();
  await db.destroy();
}
console.log(JSON.stringify(report));
if (failure) throw failure;
