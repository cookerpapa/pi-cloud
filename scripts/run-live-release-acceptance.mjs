import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, randomInt, createHash } from "node:crypto";
import sharp from "sharp";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import {
  nativeHistory,
  nativeMessages,
  runUsage,
  imageReferences,
} from "./lib/native-session-history.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import { resolve, dirname } from "node:path";
import { serializeRelease } from "./lib/release-lock.mjs";
import { runtimeCapabilityAcceptance } from "./lib/runtime-capability-acceptance.mjs";
import { guestBrowserAcceptance } from "./lib/guest-browser-acceptance.mjs";
import { elasticRetentionAcceptance } from "./lib/elastic-retention-acceptance.mjs";
if (process.env.PI_CLOUD_LIVE_RELEASE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_RELEASE_CHECK=1 to authorize owned Cube/browser fixtures and GPT-6 Luna use",
  );
if (
  process.env.PI_CLOUD_LIVE_RUNTIME_CAPABILITIES === "1" ||
  process.env.PI_CLOUD_LIVE_ELASTIC_RETENTION === "1"
)
  serializeRelease(runtimeDirectory);
const capabilityScope = process.env.PI_CLOUD_RUNTIME_CAPABILITY_SCOPE ?? "all";
assert(["all", "catalog"].includes(capabilityScope), "Unknown runtime capability acceptance scope");
assert(capabilityScope === "all" || process.env.PI_CLOUD_LIVE_RUNTIME_CAPABILITIES === "1");
const output = resolve(
  process.env.PI_CLOUD_ACCEPTANCE_REPORT ?? "dist/release-targeted-acceptance.json",
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });

const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const baseUrl = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  checkedAt: new Date().toISOString(),
  scope: capabilityScope,
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  runs: [],
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
let tenant, api, project, session, failure;
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, budget = 240000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error(label + " timed out");
}
const progress = (phase) => console.log(JSON.stringify({ phase, at: new Date().toISOString() }));
async function settled(runId) {
  const run = await until(async () => {
    const r = await api.getRun(runId);
    return terminal(r) ? r : false;
  }, "Run settlement");
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "native seal");
  return run;
}
async function completed(runId) {
  const run = await settled(runId);
  const history = await nativeHistory(db, { runId });
  report.runs.push({ runId, state: run.state, usage: runUsage(history) });
  if (run.state !== "completed") {
    // Capture bounded fixture diagnostics before deleting its history. Never
    // retain prompts, Tool arguments, pixels or request/provider credentials.
    report.runFailure = {
      runId,
      failure: run.failure,
      modelErrors: nativeMessages(history)
        .filter((message) => message.role === "assistant" && message.stopReason === "error")
        .map((message) => String(message.errorMessage ?? "Model request failed").slice(0, 1000)),
    };
  }
  assert.equal(run.state, "completed", run.failure?.code ?? "Run failed");
  return history;
}
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-" + Date.now().toString(36),
    ownerDisplayName: "Matched release acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), baseUrl), init),
    tenant.credential.token,
  );
  project = await api.createProject("Matched release acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Matched release acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (capabilityScope === "all") {
    const code = String(randomInt(100000, 999999));
    const png = await sharp(
      Buffer.from(
        `<svg width="600" height="240"><rect width="600" height="240" fill="white"/><text x="300" y="150" text-anchor="middle" font-family="sans-serif" font-size="85">${code}</text></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const prompt = "直接查看附加的图片，只回复图中的六位数字。不要调用任何工具。";
    progress("start owned cancellable Bash");
    const active = await api.acceptTurn(
      session.sessionId,
      "仅调用一次 bash，执行 sleep 45; printf WAIT_DONE。等待工具完成后回复 WAIT_DONE，不要搜索、委派或运行其他命令。",
      newIdempotencyKey("release-running"),
      "low",
    );
    await until(async () => {
      const r = await api.getRun(active.runId);
      if (terminal(r)) throw Error("Active Run ended before cancellation fixture");
      const c = await api.getConversation(session.sessionId);
      return c.turns
        .find((t) => t.runId === active.runId)
        ?.transcript?.items.some(
          (i) => i.kind === "tool" && i.toolName === "bash" && i.status === "running",
        );
    }, "Running Bash");
    progress("browser lost reply, Stop, return, image resend");
    let calls;
    await withChromePage({}, async (page) => {
      const composerUpload = ".product-composer-area > .upload-cards .upload-card";
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: "Bearer " + tenant.credential.token },
      });
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `const original=window.fetch.bind(window);window.releaseCalls=[];window.releaseReturned=[];let lose=true;window.fetch=async(input,init)=>{const response=await original(input,init);if(String(input).includes('/returned-inputs')&&!String(input).endsWith('/acknowledgements')&&response.ok){const p=await response.clone().json();window.releaseReturned.push(...p.items);}if(String(input).endsWith('/turns')&&init?.method==='POST'&&response.ok){const r=await response.clone().json();window.releaseCalls.push({key:new Headers(init.headers).get('idempotency-key'),kind:r.kind,inputId:r.inputId,runId:r.runId,turnId:r.turnId,replayed:r.replayed,body:JSON.parse(init.body)});if(lose){lose=false;throw new TypeError('Release fixture discarded a committed admission reply');}}return response;};`,
      });
      await page.navigate(baseUrl + "/?session=" + session.sessionId);
      await page.waitFor(
        "document.querySelector('.product-stop-button') && document.querySelector('.product-composer textarea')",
      );
      const fill = async (text) => {
        await page.evaluate(
          `(()=>{const i=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      };
      await fill(prompt);
      await page.evaluate(
        `(()=>{const files=new DataTransfer();files.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}),c=>c.charCodeAt(0))],'return-image.png',{type:'image/png'}));const input=document.querySelector('input[type=file]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await page.waitFor(
        `document.querySelector('${composerUpload}') && document.querySelector('.product-steer-button')?.disabled===false`,
      );
      const send = () =>
        page.evaluate(
          "document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
        );
      await send();
      await page.waitFor(
        "releaseCalls.length===1 && (document.querySelector('.product-steer-button')??document.querySelector('.product-send-button'))?.disabled===false",
      );
      const original = await page.evaluate("releaseCalls[0]");
      assert.equal(original.kind, "input");
      assert.equal(original.runId, active.runId);
      assert.equal((await api.getRun(original.runId)).state, "running");
      assert.equal(original.body.uploadIds.length, 1);
      // Force the formerly racy layout: both the queued copy and the draft image
      // must be visible before removing just the draft attachment.
      await page.waitFor("document.querySelector('.pending-input-queue .upload-card')");
      await page.waitFor(
        `document.querySelector('${composerUpload} button[aria-label]')?.disabled===false`,
      );
      await fill("");
      await page.evaluate(`document.querySelector('${composerUpload} button[aria-label]').click()`);
      await page.waitFor(`!document.querySelector('${composerUpload}')`);
      assert(
        await page.evaluate("Boolean(document.querySelector('.pending-input-queue .upload-card'))"),
      );
      report.draftRemovalPreservesQueuedImage = true;
      assert.equal((await api.getRun(active.runId)).state, "running");
      await page.evaluate("document.querySelector('.product-stop-button').click()");
      await page.waitFor(
        `document.querySelector('.product-composer textarea').value===${JSON.stringify(prompt)} && document.querySelector('${composerUpload}')`,
      );
      const returned = await page.evaluate("releaseReturned");
      assert(
        returned.some(
          (i) =>
            i.inputId === original.inputId &&
            i.idempotencyKey === original.key &&
            i.uploads.some((u) => u.id === original.body.uploadIds[0]),
        ),
      );
      await page.waitFor(
        "(document.querySelector('.product-steer-button')??document.querySelector('.product-send-button'))?.disabled===false",
      );
      await send();
      await page.waitFor(
        "releaseCalls.length===2 && document.querySelector('.product-composer textarea').value===''",
      );
      calls = await page.evaluate("releaseCalls");
      assert.notEqual(calls[0].key, calls[1].key);
      assert.notEqual(calls[0].runId, calls[1].runId);
      assert.equal(calls[1].replayed, false);
      assert.deepEqual(calls[1].body.uploadIds, calls[0].body.uploadIds);
    });
    const cancelled = await settled(active.runId);
    assert.equal(cancelled.state, "cancelled");
    const stopped = await api.getRun(calls[0].runId);
    assert.equal(stopped.state, "cancelled");
    const imageHistory = await completed(calls[1].runId),
      messages = nativeMessages(imageHistory);
    assert(
      messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content ?? [])
        .some((c) => c.type === "text" && c.text.includes(code)),
      "Resubmitted image was not read",
    );
    assert(
      !messages.some((m) => m.role === "toolResult"),
      "Explicitly attached image should not need a Tool",
    );
    assert(imageReferences(imageHistory).length > 0, "Canonical image reference missing");
    assert.equal(
      (
        await db
          .selectFrom("runs")
          .select("id")
          .where("session_id", "=", session.sessionId)
          .execute()
      ).length,
      2,
    );
    report.returnedInput = {
      nativeInputInOriginalRun: true,
      realBrowser: true,
      requests: 2,
      distinctKeys: 2,
      distinctAdmissions: 2,
      originalRunCancelled: true,
      newRunCompleted: true,
      sameUploadId: true,
      directVision: true,
      activeRunCancelled: true,
    };
    progress("oversized Read through guest, completion, Worker and canonical native history");
    const files = [
      {
        name: "wide-ascii.txt",
        offset: 1,
        prefix: "WIDE_ASCII_BEGIN_",
        content: "WIDE_ASCII_BEGIN_" + "x".repeat(120000),
      },
      {
        name: "wide-unicode.txt",
        offset: 2,
        prefix: "WIDE_UTF8_BEGIN_",
        content: "header\n\uFEFFWIDE_UTF8_BEGIN_" + "中😀".repeat(20000) + "\r\nend",
      },
    ];
    for (const file of files)
      file.upload = await api.uploadWorkspaceFile(
        session.sessionId,
        randomUUID(),
        new Blob([file.content], { type: "text/plain" }),
        file.name,
      );
    const readRun = await api.acceptTurn(
      session.sessionId,
      "严格分别调用一次 read，参数为这两个 JSON 对象：" +
        JSON.stringify(
          files.map((f) => ({ path: `@${f.upload.path}`, offset: f.offset, limit: 1 })),
        ) +
        "。保留 path 开头的 @，不要修改路径字符串。不要用 bash，不要继续读剩余内容，不要搜索或委派。两次读取后只回复两个短标签 WIDE_ASCII_BEGIN_ 和 WIDE_UTF8_BEGIN_，不要复制标签后面的任何正文或重复字符。最终回答最多两行。",
      newIdempotencyKey("release-read"),
      "low",
    );
    const history = await completed(readRun.runId);
    const results = history.filter((r) => r.entry.kind === "pi.tool-result");
    const modelResults = nativeMessages(history).filter((m) => m.role === "toolResult");
    const readCalls = nativeMessages(history)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content.filter((part) => part.type === "toolCall" && part.name === "read"));
    assert.deepEqual(
      readCalls.map((call) => call.arguments.path).sort(),
      files.map((file) => `@${file.upload.path}`).sort(),
      "The live Read check must exercise native @ path interpretation",
    );
    report.readPathAliases = true;
    assert.equal(modelResults.length, 2);
    assert(modelResults.every((r) => r.toolName === "read" && !r.isError));
    report.read = [];
    for (const file of files) {
      const result = modelResults.find((r) =>
        r.content?.some((c) => c.type === "text" && c.text.startsWith(file.prefix)),
      );
      assert(result, "Actual file prefix missing");
      const text = result.content[0].text,
        size = Buffer.byteLength(text);
      assert(size >= 51193 && size <= 51200);
      assert(!text.includes("\uFFFD"));
      assert(
        result.content.some(
          (c) =>
            c.type === "text" &&
            c.text.includes("<harness>") &&
            c.text.includes("tail -c +") &&
            c.text.includes("50.0KB limit"),
        ),
        "Canonical continuation diagnostic missing",
      );
      const row = history.find((r) =>
        r.entry.model?.some((m) => m.role === "toolResult" && m.toolCallId === result.toolCallId),
      );
      assert(
        row.entry.data.diagnostics.some((d) => d.code === "truncated" && d.severity === "warn"),
      );
      report.read.push({
        kind: file.name,
        sourceBytes: Buffer.byteLength(file.content),
        contentBytes: size,
        utf8Valid: true,
        canonicalDiagnostic: true,
      });
    }
  }
  if (process.env.PI_CLOUD_LIVE_RUNTIME_CAPABILITIES === "1") {
    report.runtimeCapabilities = await runtimeCapabilityAcceptance({
      scope: capabilityScope,
      db,
      api,
      tenant,
      session,
      baseUrl,
      directory: dirname(output),
      completed,
      progress,
      save: async (value) => {
        report.runtimeCapabilities = value;
        await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
      },
    });
  }
  if (process.env.PI_CLOUD_LIVE_GUEST_BROWSER === "1") {
    report.guestBrowser = await guestBrowserAcceptance({
      api,
      tenant,
      session,
      baseUrl,
      completed,
      progress,
    });
  }
  if (process.env.PI_CLOUD_LIVE_ELASTIC_RETENTION === "1") {
    report.elasticRetention = await elasticRetentionAcceptance({
      database: db,
      api,
      tenant,
      session,
      completed,
      progress,
      save: async (value) => {
        report.elasticRetention = value;
        await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
      },
    });
  }
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 600);
} finally {
  const errors = [];
  try {
    if (session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await until(
        async () =>
          !(
            await db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .where("output_seal_id", "is not", null)
              .where("output_sealed_at", "is", null)
              .execute()
          ).length,
        "cleanup seals",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
      await until(
        async () =>
          Boolean(
            (
              await db
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", project.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          ),
        "owned Workspace physical purge",
      );
    }
  } catch (error) {
    errors.push(String(error?.message ?? error).slice(0, 300));
  }
  if (tenant) {
    await db
      .updateTable("tenant_api_credentials")
      .set({ revoked_at: new Date() })
      .where("credential_id", "=", tenant.credential.credentialId)
      .execute();
    if (!errors.length) {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
        ),
      });
      try {
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
          "owned control delivery",
        );
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } catch (error) {
        errors.push(String(error?.message ?? error).slice(0, 300));
      } finally {
        blobs.close();
      }
    }
  }
  report.cleanupConfirmed = errors.length === 0;
  if (errors.length) report.cleanupErrors = errors;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await db.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      returnedInput: report.returnedInput,
      read: report.read,
      failure: report.failure,
    }),
  );
  if (failure || errors.length)
    throw new Error("Targeted release acceptance failed; inspect private bounded evidence");
}
