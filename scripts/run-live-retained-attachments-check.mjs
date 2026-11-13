import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import sharp from "sharp";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { assertLiveContract } from "./lib/live-contract.mjs";
import { serviceAddress, runtimeDirectory } from "./lib/production-kubernetes.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";

if (process.env.PI_CLOUD_LIVE_RETAINED_ATTACHMENTS_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_RETAINED_ATTACHMENTS_CHECK=1 for owned Luna/Cube/browser attachment acceptance",
  );
const output = process.argv[2] ?? "/tmp/pi-cloud-retained-attachments-live.json";
const env = await readFile(`${runtimeDirectory}/.env`, "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const endpoint = new URL(
  (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const blobs = new S3AttachmentBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  region: "us-east-1",
  bucket: "pi-cloud-session-images",
  ...JSON.parse(
    await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
  ),
});
const scenario = process.argv[3] ?? "all";
assert(
  ["all", "originals", "queue", "vision"].includes(scenario),
  "Use all, originals, queue or vision",
);
const report = {
  at: new Date().toISOString(),
  model: "gpt-6-luna",
  scenario,
  accepted: false,
  runs: [],
};
const sessions = [],
  workspaces = [];
let tenant, api, failure;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function until(read, label, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out`);
}
async function settled(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r.state) && r;
  }, "Run settlement");
  await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !r.output_seal_id || r.output_sealed_at;
  }, "Ordered writer closure");
  return run;
}
async function completed(sessionId, runId) {
  const run = await settled(runId);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const turn = await until(
    async () =>
      (await api.getConversation(sessionId)).turns.find(
        (t) => t.runId === runId && t.transcript?.terminalSequence,
      ),
    "Projected history",
  );
  const tools = turn.transcript.items
    .filter((i) => i.kind === "tool")
    .map((i) => ({ name: i.toolName, status: i.status }));
  assert(
    tools.every((t) => t.status === "completed"),
    "A fixture Tool did not complete",
  );
  const model = await db
    .selectFrom("runs")
    .select("model_id")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(model.model_id, report.model);
  report.runs.push({ runId, tools });
  await save();
  return {
    turn,
    tools,
    text: turn.transcript.items
      .filter((i) => i.kind === "text")
      .map((i) => i.text)
      .join("\n"),
  };
}
async function run(sessionId, prompt, uploadIds = []) {
  await idleWriter(sessionId);
  const accepted = await api.acceptTurn(
    sessionId,
    prompt,
    newIdempotencyKey("turn"),
    "low",
    uploadIds,
  );
  assert.equal(accepted.kind, "run");
  return completed(sessionId, accepted.runId);
}
async function idleWriter(sessionId) {
  await until(
    async () =>
      (
        await sql`select not exists(select 1 from sessions s join session_leases l
    on l.tenant_id=s.tenant_id and l.pi_session_id=s.pi_session_id
    where s.id=${sessionId}::uuid and l.released_at is null) as idle`.execute(db)
      ).rows[0].idle,
    "Idle Session writer",
  );
}
async function removeConversation(id) {
  await until(async () => {
    try {
      await api.deleteConversation(id);
      return true;
    } catch (e) {
      if (e.status === 404) return true;
      if (e.status === 409) return false;
      throw e;
    }
  }, "Owned conversation cleanup");
}
async function removeWorkspace(id) {
  const key = newIdempotencyKey("delete");
  await api.deleteWorkspace(id, key);
  await until(async () => {
    const row = await db
      .selectFrom("workspaces")
      .select(["deleted_at", "storage_purged_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return row.deleted_at && row.storage_purged_at;
  }, "Owned physical Workspace cleanup");
}

async function queuedText(sessionId) {
  await idleWriter(sessionId);
  const marker = randomUUID().replaceAll("-", "");
  const old = await api.uploadWorkspaceFile(
    sessionId,
    randomUUID(),
    new Blob([`UNUSED_${marker}\n` + "pending text\n".repeat(5000)]),
    "first.txt",
  );
  const latest = await api.uploadWorkspaceFile(
    sessionId,
    randomUUID(),
    new Blob([`LATEST_${marker}\n`]),
    "latest.txt",
  );
  const root = await api.acceptTurn(
    sessionId,
    "Run bash exactly once: sleep 20. After that, answer briefly. Subsequent messages may change your instructions.",
    newIdempotencyKey("turn"),
    "low",
  );
  assert.equal(root.kind, "run");
  await until(
    async () =>
      (await api.getConversation(sessionId)).turns
        .find((t) => t.runId === root.runId)
        ?.transcript?.items.some(
          (i) => i.kind === "tool" && i.toolName === "bash" && i.status === "running",
        ),
    "Running Tool boundary",
  );
  const accepted = await api.acceptTurn(
    sessionId,
    "使用 read 读取刚附带文件的首行（limit=1），只回复该行。",
    newIdempotencyKey("turn"),
    "low",
    [old.id],
    "follow_up",
  );
  assert.equal(accepted.kind, "input");
  assert.equal(accepted.runId, root.runId);
  const queue = await until(async () => {
    const q = await api.getInputQueue(sessionId);
    return q.items.some((i) => i.inputId === accepted.inputId) && q;
  }, "Native input placement");
  const updated = await api.mutateQueuedInput(
    sessionId,
    accepted.inputId,
    {
      action: "steer",
      revision: queue.revision,
      text: "使用 read 读取本条消息最新附带文件的首行（limit=1），只回复该行。",
      uploadIds: [latest.id],
    },
    newIdempotencyKey("turn"),
  );
  assert.deepEqual(
    updated.queue.items.find((i) => i.inputId === accepted.inputId)?.uploads.map((u) => u.id),
    [latest.id],
  );
  const result = await completed(sessionId, root.runId);
  assert(result.tools.some((t) => t.name === "read"));
  assert(result.text.includes(`LATEST_${marker}`));
  assert(!result.text.includes(`UNUSED_${marker}`));
  const count = (
    await sql`select count(*)::int n from runs where tenant_id=${tenant.tenantId}::uuid and id=${root.runId}::uuid`.execute(
      db,
    )
  ).rows[0].n;
  assert.equal(count, 1);
  report.queuedText = { sameRun: true, atomicEditedSteer: true, latestOriginalObserved: true };
  await save();
}

async function directVision(sessionId) {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const bytes = await sharp(
    Buffer.from(
      `<svg width="600" height="240"><rect width="600" height="240" fill="white"/><text x="300" y="150" text-anchor="middle" font-family="sans-serif" font-size="85">${code}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const uploaded = await api.uploadWorkspaceFile(
    sessionId,
    randomUUID(),
    new Blob([bytes]),
    "vision.png",
  );
  assert(uploaded.image);
  assert.equal(sha((await api.readInputImage(uploaded)).bytes), sha(bytes));
  const answer = await run(
    sessionId,
    "直接看这条消息附带的图片，只输出图片中的六位数字，不要调用任何工具。",
    [uploaded.id],
  );
  assert.equal(answer.tools.length, 0);
  assert(answer.text.includes(code));
  report.vision = {
    originalVerified: true,
    directVisionWithoutRead: true,
    byteLength: bytes.length,
  };
  await save();
}
try {
  report.contract = await assertLiveContract(db, runtimeDirectory, { modelRuntimeSnapshot: 1 });
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-files-${randomUUID()}`,
    ownerDisplayName: "Retained attachment acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  const project = await api.createProject("Retained attachment fixture", { kind: "empty" });
  workspaces.push(project.workspaceId);
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Retained attachment fixture",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  sessions.push(session.sessionId);
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  await save();
  let queueTarget = session.sessionId;
  if (["all", "originals"].includes(scenario)) {
    const marker = randomUUID().replaceAll("-", "");
    const pasted = `BEGIN_${marker}\n` + "原始日志 🚲 保留全文\n".repeat(5000) + `END_${marker}\n`;
    let expected, upload, first;
    await withChromePage({ width: 1280, height: 900 }, async (page) => {
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: `Bearer ${tenant.credential.token}` },
      });
      await page.navigate(base);
      await page.waitFor(
        "document.querySelector('.product-conversation-row:not(.product-delegated-session)>button')",
      );
      await page.evaluate(
        "[...document.querySelectorAll('.product-conversation-row:not(.product-delegated-session)>button')].find(b=>b.textContent.includes('Retained attachment fixture')).click()",
      );
      await page.waitFor(
        "document.querySelector('.product-topbar-title strong')?.textContent==='Retained attachment fixture'",
      );
      await page.waitFor(
        "document.querySelector('.product-composer textarea') && !document.querySelector('.product-composer textarea').disabled",
      );
      await page.evaluate("document.querySelector('.product-composer textarea').focus()");
      await page.send("Input.insertText", {
        text: "请先用 read 工具读取附件首行（limit=1），再用 bash 的 tail -n 1 输出最后一行。最后只原样输出这两行，不要搜索或调用子代理。",
      });
      await page.evaluate(
        `(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(pasted)});document.querySelector('.product-composer textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`,
      );
      await page.waitFor(
        "document.querySelector('.product-composer-shell>.upload-cards .attachment-name')",
      );
      assert.equal(
        Number(
          (
            await sql`select count(*)::int n from session_uploads where session_id=${session.sessionId}::uuid`.execute(
              db,
            )
          ).rows[0].n,
        ),
        0,
      );
      await page.evaluate(
        "document.querySelector('.product-composer-shell>.upload-cards .attachment-name').click()",
      );
      await page.waitFor("document.querySelector('.text-attachment-dialog textarea')");
      await page.evaluate(
        "document.querySelector('.text-attachment-dialog textarea').focus();document.querySelector('.text-attachment-dialog textarea').setSelectionRange(0,0)",
      );
      await page.send("Input.insertText", { text: "EDITED_" });
      expected = Buffer.from(
        await page.evaluate("document.querySelector('.text-attachment-dialog textarea').value"),
      );
      await page.evaluate(
        "[...document.querySelectorAll('.text-attachment-dialog button')].find(b=>['Save','保存'].includes(b.textContent)).click()",
      );
      await page.waitFor("!document.querySelector('.text-attachment-dialog')");
      await page.evaluate("document.querySelector('.product-send-button').click()");
      const row = await until(
        async () =>
          db
            .selectFrom("runs")
            .select(["id", "input_text", "input_uploads"])
            .where("session_id", "=", session.sessionId)
            .executeTakeFirst(),
        "Pasted input admission",
      );
      assert(
        Buffer.byteLength(JSON.stringify({ text: row.input_text, uploads: row.input_uploads })) <
          4096,
      );
      upload = row.input_uploads[0];
      assert(upload.original);
      assert.equal(upload.sha256, sha(expected));
      assert.equal(sha((await api.readInputAttachment(upload)).bytes), sha(expected));
      first = await completed(session.sessionId, row.id);
      assert(
        first.tools.some((t) => t.name === "read") && first.tools.some((t) => t.name === "bash"),
      );
      assert(first.text.includes(`EDITED_BEGIN_${marker}`) && first.text.includes(`END_${marker}`));
      report.browserPaste = {
        characters: [...pasted].length,
        byteLength: expected.length,
        localBeforeSend: true,
        editable: true,
        boundedInput: true,
        nativeReadAndBash: true,
      };
      await save();
    });
    const changed = await run(
      session.sessionId,
      `只运行一次 bash，执行 printf '%s' WORKSPACE_COPY_CHANGED > '${upload.path}'，然后 cat '${upload.path}'。只回复命令输出。此文件属于本验收。`,
    );
    assert(changed.tools.some((t) => t.name === "bash"));
    assert.equal(
      Buffer.from(
        (await api.readWorkspaceFile(session.sessionId, upload.path.slice("/workspace/".length)))
          .bytes,
      ).toString(),
      "WORKSPACE_COPY_CHANGED",
    );
    assert.equal(sha((await api.readInputAttachment(upload)).bytes), sha(expected));
    report.mutableCopyIndependent = true;
    await save();
    const tree = await api.getConversationTree(session.sessionId, "focus");
    const point = tree.branches
      .flatMap((b) => b.entries)
      .find((e) => e.turnId === first.turn.turnId && e.finalAssistant);
    assert(point, "Fixture final answer has no Fork point");
    const fork = await api.forkConversation(
      session.sessionId,
      first.turn.turnId,
      point.entryId,
      "Retained attachment Fork",
      newIdempotencyKey("fork"),
    );
    sessions.push(fork.session.sessionId);
    await removeConversation(session.sessionId);
    let inherited = (await api.getConversation(fork.session.sessionId)).turns.find(
      (t) => t.turnId === first.turn.turnId,
    ).uploads[0];
    assert.equal(inherited.sessionId, fork.session.sessionId);
    assert.equal(sha((await api.readInputAttachment(inherited)).bytes), sha(expected));
    report.sourceDeletionSafe = true;
    await save();
    await removeWorkspace(project.workspaceId);
    assert.equal(sha((await api.readInputAttachment(inherited)).bytes), sha(expected));
    report.workspaceDeletionSafe = true;
    await save();
    const fresh = await api.createProject("Restored attachment fixture", { kind: "empty" });
    workspaces.push(fresh.workspaceId);
    await api.rebindConversationWorkspace(
      fork.session.sessionId,
      fresh.workspaceId,
      newIdempotencyKey("rebind"),
    );
    const reused = await api.reuseInputAttachment(fork.session.sessionId, randomUUID(), inherited);
    assert.equal(reused.original.attachment.id, upload.original.attachment.id);
    assert.notEqual(reused.workspaceId, upload.workspaceId);
    assert.notEqual(reused.path, upload.path);
    const restored = await run(
      fork.session.sessionId,
      "只对本条消息刚附带的文件执行 bash sha256sum，输出完整校验值。不要读取旧路径。",
      [reused.id],
    );
    assert(restored.tools.some((t) => t.name === "bash"));
    assert(restored.text.includes(sha(expected)));
    report.newWorkspaceCopy = { sameOriginal: true, newPlacement: true, actualGuestDigest: true };
    queueTarget = fork.session.sessionId;
  }
  if (["all", "queue"].includes(scenario)) await queuedText(queueTarget);
  if (["all", "vision"].includes(scenario)) await directVision(queueTarget);
  report.accepted = true;
  await save();
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message };
} finally {
  const errors = [];
  if (tenant && api) {
    for (const id of [...sessions].reverse())
      try {
        const rows = await db
          .selectFrom("runs")
          .select(["id", "turn_id"])
          .where("session_id", "=", id)
          .execute();
        await settleOwnedAcceptanceRuns(api, id, rows, settled);
        await removeConversation(id);
      } catch (e) {
        errors.push(e);
      }
    for (const id of workspaces)
      try {
        const row = await db
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", id)
          .executeTakeFirst();
        if (row && !row.storage_purged_at) await removeWorkspace(id);
      } catch (e) {
        errors.push(e);
      }
    if (!errors.length)
      try {
        await until(
          async () =>
            Number(
              (
                await sql`select count(*)::int n from outbox where tenant_id=${tenant.tenantId}::uuid and published_at is null`.execute(
                  db,
                )
              ).rows[0].n,
            ) === 0,
          "Owned cleanup propagation",
        );
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } catch (e) {
        errors.push(e);
      }
  }
  report.cleanupSucceeded = errors.length === 0;
  if (errors.length)
    report.cleanupErrors = errors.map((e) => ({ name: e.name, message: e.message }));
  await save();
  blobs.close();
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Retained attachment live acceptance failed",
    );
}
console.log(JSON.stringify(report));
