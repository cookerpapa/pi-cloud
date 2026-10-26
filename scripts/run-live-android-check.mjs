import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import {
  issuePrivateTenantCredential,
  revokePrivateTenantCredential,
} from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  nativeHistory,
  nativeMessages,
  imageReferences,
  runUsage,
} from "./lib/native-session-history.mjs";
import {
  S3ImageBlobStore,
  PostgresImageAttachmentStore,
} from "../packages/session-attachments/src/index.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
if (process.env.PI_CLOUD_LIVE_ANDROID_CHECK !== "1")
  throw Error("Set PI_CLOUD_LIVE_ANDROID_CHECK=1 for the owned Android device and Luna acceptance");
const [targetId, outputPath] = process.argv.slice(2);
assert(
  /^[a-f0-9-]{36}$/.test(targetId ?? "") && outputPath,
  "Supply target UUID and private report path",
);
const output = resolve(outputPath);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const blobs = new S3ImageBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(
    await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
  ),
});
const images = new PostgresImageAttachmentStore(db, blobs);
const baseUrl = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  at: new Date().toISOString(),
  targetId,
  accepted: false,
  cleanupConfirmed: false,
  model: "gpt-6-luna",
  runs: [],
};
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(label + " timed out");
}
let credential, target, project, session, active, api, failure;
try {
  target = await db
    .selectFrom("execution_targets")
    .selectAll()
    .where("id", "=", targetId)
    .executeTakeFirstOrThrow();
  assert.equal(target.bound_session_id, null, "Never take over a user's bound device");
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("tenant_id", "=", target.tenant_id)
    .orderBy("created_at")
    .executeTakeFirstOrThrow();
  credential = await issuePrivateTenantCredential(db, {
    tenant: target.tenant_id,
    userId: user.id,
    label: "Owned Android acceptance",
    role: "owner",
    expiresAt: new Date(Date.now() + 3600000),
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), baseUrl), init),
    credential.token,
  );
  project = await api.createProject("Android acceptance " + Date.now(), { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Android acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  report.credentialId = credential.credentialId;
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + credential.token },
    });
    await page.navigate(baseUrl + "/?session=" + session.sessionId);
    await page.waitFor(
      "[...document.querySelectorAll('button')].some(b=>!b.disabled&&['云手机','Cloud phone'].includes(b.textContent.trim()))",
    );
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(b=>['云手机','Cloud phone'].includes(b.textContent.trim())).click()",
    );
    try {
      await page.waitFor(
        "document.querySelector('.product-device-modal select')?.disabled === false",
      );
    } catch (error) {
      report.devicePickerFailure = await page.evaluate(
        "({modal:document.querySelector('.product-device-modal')?.innerText, select:document.querySelector('.product-device-modal select')?.outerHTML, alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.innerText)})",
      );
      await page.screenshot(output + ".failure.png");
      throw error;
    }
    await page.evaluate(
      `(() => { const select=document.querySelector('.product-device-modal select'); select.value=${JSON.stringify(targetId)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    );
    await page.waitFor(
      "document.querySelector('.product-device-actions button:last-child')?.disabled === false",
    );
    await page.evaluate(
      "document.querySelector('.product-device-actions button:last-child').click()",
    );
    await until(
      async () =>
        (await api.getSessionExecutionTarget(session.sessionId)).target?.targetId === targetId,
      "browser device binding",
    );
    report.browserBinding = true;
  });
  console.log(
    JSON.stringify({ phase: "native Android model round", sessionId: session.sessionId }),
  );
  active = await api.acceptTurn(
    session.sessionId,
    "只使用 Android 工具验收这台测试设备。先按 Home，然后打开 com.android.settings，观察屏幕；在设置页滑动一次并再次观察；找到设置搜索框，点击它，输入中文“PiCloud你好”，再观察并确认输入是否成功。不要使用 Bash、子 Agent 或修改账号、系统设置。最后简短回答 ANDROID_OK 和实际看见的搜索文字。",
    newIdempotencyKey("android-check"),
    "low",
  );
  const run = await until(
    async () => {
      const r = await api.getRun(active.runId);
      return terminal(r) ? r : false;
    },
    "Android model Run",
    900000,
  );
  report.runs.push({ runId: run.runId, state: run.state, failure: run.failure });
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  await until(
    async () =>
      !(await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("tenant_id", "=", target.tenant_id)
        .where(
          "pi_session_id",
          "=",
          (
            await db
              .selectFrom("sessions")
              .select("pi_session_id")
              .where("id", "=", session.sessionId)
              .executeTakeFirstOrThrow()
          ).pi_session_id,
        )
        .where("released_at", "is", null)
        .executeTakeFirst()),
    "writer retirement",
  );
  const history = await nativeHistory(db, { runId: run.runId });
  const messages = nativeMessages(history),
    results = messages.filter((m) => m.role === "toolResult");
  const names = [...new Set(results.map((m) => m.toolName))];
  for (const name of [
    "android_observe",
    "android_tap",
    "android_swipe",
    "android_input_text",
    "android_key",
    "android_open_app",
  ])
    assert(names.includes(name), "Missing real Tool result: " + name);
  assert(
    results.every((m) => m.isError !== true),
    "Device tool error in acceptance",
  );
  const refs = imageReferences(history.map((r) => r.entry));
  assert(refs.length >= 2, "Need retained device screenshots");
  for (const ref of refs) {
    const bytes = await images.get(target.tenant_id, ref);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
  }
  const answer = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  assert(
    answer.includes("ANDROID_OK") && answer.includes("PiCloud你好"),
    "Model did not confirm the visible Chinese input",
  );
  report.runs[0].usage = runUsage(history);
  report.tools = names;
  report.retainedImages = refs.map((r) => ({ id: r.id, bytes: r.byteLength }));
  const allocation = await db
    .selectFrom("workspace_runtimes")
    .select("workspace_runtime_id")
    .where("tenant_id", "=", target.tenant_id)
    .where("workspace_id", "=", project.workspaceId)
    .execute();
  assert.equal(allocation.length, 0, "Phone tools must not allocate a Cube VM");
  report.noCubeAllocation = true;
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + credential.token },
    });
    await page.navigate(baseUrl + "/?session=" + session.sessionId);
    await page.waitFor(
      "[...document.querySelectorAll('img')].some(i=>i.complete&&i.naturalWidth>100)",
    );
    report.browserImages = await page.evaluate(
      "[...document.querySelectorAll('img')].filter(i=>i.complete&&i.naturalWidth>100).length",
    );
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(b=>['云手机','Cloud phone'].includes(b.textContent.trim())).click()",
    );
    try {
      await page.waitFor(
        "document.querySelector('.product-device-modal select')?.disabled === false",
      );
    } catch (error) {
      report.devicePickerFailure = await page.evaluate(
        "({modal:document.querySelector('.product-device-modal')?.innerText, select:document.querySelector('.product-device-modal select')?.outerHTML, alerts:[...document.querySelectorAll('[role=alert]')].map(x=>x.innerText)})",
      );
      await page.screenshot(output + ".failure.png");
      throw error;
    }
    assert.equal(
      await page.evaluate("document.querySelector('.product-device-modal select').value"),
      targetId,
    );
    await page.evaluate("document.querySelector('.product-device-actions button').click()");
    await page.waitFor("document.querySelector('.product-device-screen')?.naturalWidth>100");
    const capture = await page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(output + ".png", Buffer.from(capture.data, "base64"), { mode: 0o600 });
    report.devicePicker = true;
  });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error);
} finally {
  const errors = [];
  try {
    if (active && !terminal(await api.getRun(active.runId))) {
      await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("android-clean"));
      await until(async () => terminal(await api.getRun(active.runId)), "owned Run cancellation");
    }
    if (session) {
      await until(async () => {
        const { rows } =
          await sql`select 1 from execution_target_bindings where tenant_id=${target.tenant_id}::uuid and session_id=${session.sessionId}::uuid limit 1`.execute(
            db,
          );
        return !rows.length;
      }, "device admission cleanup");
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("android-clean"));
      await until(async () => {
        const row = await db
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", project.workspaceId)
          .executeTakeFirst();
        return !row || row.storage_purged_at;
      }, "owned Workspace cleanup");
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    errors.push(error);
    report.cleanupError = String(error);
  }
  if (credential) {
    try {
      await revokePrivateTenantCredential(db, {
        tenant: target.tenant_id,
        credentialId: credential.credentialId,
      });
      // This credential was created by this fixture, not a pre-existing account key.
      await db
        .deleteFrom("tenant_api_credentials")
        .where("credential_id", "=", credential.credentialId)
        .where("tenant_id", "=", target.tenant_id)
        .where("revoked_at", "is not", null)
        .execute();
    } catch (error) {
      errors.push(error);
    }
  }
  report.accepted = report.accepted && errors.length === 0;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  blobs.close();
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Android acceptance failed; see private report",
    );
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    tools: report.tools,
    images: report.retainedImages.length,
    browser: report.devicePicker,
    cleanupConfirmed: report.cleanupConfirmed,
  }),
);
